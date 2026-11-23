#!/usr/bin/env python3
"""writer-Auditor targeted band probe #90 — deterministic, re-runnable, fail-closed.

Band: every `status -> done` close write strictly after probe #89's audited upper edge
(2026-11-22T16:18:57.006Z), re-derived from the platform at run time. Exit 0 == VERDICT: PASS
and ghost_pass=0. Any ghost/ambiguous write -> exit 1.

Band #84's open item #1 is fixed here: the classifier now reads every close/guard action name the
company feed actually emits (see GUARD/FLAG below), gives overridden closes their own bucket
carrying `disposition`, and DISCOVERS close/guard-shaped names it does not classify.

Modes:
  python3 probe90.py --snapshot   freeze band90.json from a fresh snapshot
  python3 probe90.py              REPRO mode: requires the as-filed population to reproduce
"""
import json, os, sys, re, urllib.request, datetime, collections

CID = os.environ["PAPERCLIP_COMPANY_ID"]
TOK = os.environ["PAPERCLIP_API_KEY"]; BASE = os.environ["PAPERCLIP_API_URL"]
PREV_EDGE = "2026-11-22T16:18:57.006Z"          # last close write COVERED by probe #89 (SUP-25025)
CHAIN_EDGE = "2026-11-19T14:07:20.178Z"         # unchanged: #79's last covered close (chain latched)
PROCESS_START = "2026-11-21T16:04:59Z"          # serving process start (serve89.py, pid 8 lstart; band entirely post-restart)
HERE = os.path.dirname(os.path.abspath(__file__))
BOUND_S = 900                                     # declaration time-match bound, seconds

# names that decide HOW a close was allowed through the guard (each row is read within the window)
OVERRIDE = "issue.done_transition_override"
BYPASS = "issue.done_tier_declaration_skipped"
GUARD = {"issue.done_transition_tier2_close", "issue.done_transition_tier1_close",
         BYPASS, "issue.done_transition_guard_skipped", OVERRIDE,
         "issue.done_transition_ladder_recovered_from_decisions"}
# names that are friction/shape around a close: reported per card, never silently ignored
# LANDING = the done_close_landing_* family band #88 said its classifier did not read (F85-5).
LANDING = {"issue.done_close_landing_reenqueued", "issue.done_close_landing_escalated",
           "issue.done_close_landing_confirmed"}
FLAG = {"issue.done_transition_refused", "issue.merge_arming_refused_on_close",
        "issue.board_stage_override", "issue.done_transition_ladder_refused",
        "issue.done_transition_ladder_refusal_repeated",
        "issue.done_missing_approval_stage_refused", "issue.done_transition_guard_note",
        "issue.done_transition_cited_sha_resolved"} | LANDING
T2 = "Closed at Tier 2 (live):"; T1 = "Closed at Tier 1 (landed, not liveness-probed):"
NONCANON_PREFIX = ("Closed at Tier",)


def get(p):
    rq = urllib.request.Request(BASE + p, headers={"Authorization": f"Bearer {TOK}"})
    return json.loads(urllib.request.urlopen(rq, timeout=180).read())


def rows_of(r):
    return r if isinstance(r, list) else (r.get("activity") or r.get("rows") or [])


def t(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def ds(dt_a, dt_b):
    return (dt_a - dt_b).total_seconds()


def close_writes_from_feed():
    upd, to, pages = [], None, 0
    while pages < 80:
        r = rows_of(get(f"/api/companies/{CID}/activity?action=issue.updated&from={PREV_EDGE}&limit=500"
                        + (f"&to={to}" if to else "")))
        pages += 1
        if not r:
            break
        upd.extend(r)
        if len(r) < 500:
            break
        to = min(x["createdAt"] for x in r)
    w = []
    for a in upd:
        d = a.get("details") or {}
        ch = d.get("changes") or {}
        if (isinstance(ch.get("status"), dict) and ch["status"].get("to") == "done") or \
           (d.get("status") == "done" and "_previous" in d):
            w.append({"id": a["entityId"], "at": a["createdAt"], "actor": a.get("actorType"),
                      "run": a.get("runId")})
    return w, pages, len(upd)


def population_a(edge_hi):
    out, after, pages = {}, PREV_EDGE, 0
    while pages < 6:
        pg = rows_of(get(f"/api/companies/{CID}/issues?status=done&limit=1000&completedAfter={after}"))
        pages += 1
        for r in pg:
            if PREV_EDGE < (r.get("completedAt") or "") <= edge_hi:
                out[r["id"]] = r
        if len(pg) < 1000:
            break
        after = pg[-1]["completedAt"]
    return out, pages


def cancelled_rescan(edge_hi):
    # SUP-21321 truncation guard: one page at row_count == limit is not a
    # population. Page cancelled to a short page before claiming in-band 0.
    hits, total, off, pages = 0, 0, 0, 0
    while pages < 40:
        pg = rows_of(get(f"/api/companies/{CID}/issues?status=cancelled&limit=500&offset={off}"))
        pages += 1
        total += len(pg)
        hits += sum(1 for r in pg if PREV_EDGE < (r.get("completedAt") or "") <= edge_hi)
        if len(pg) < 500:
            break
        off += 500
    return hits, total, pages


def thread(eid):
    act = rows_of(get(f"/api/issues/{eid}/activity?limit=500"))
    cmt = rows_of(get(f"/api/issues/{eid}/comments?limit=500"))
    return act, cmt


def decl(body):
    for l in (body or "").split("\n"):
        s = l.strip()
        if s.startswith(T2):
            return s, "tier2"
        if s.startswith(T1):
            return s, "tier1"
    for l in (body or "").split("\n"):
        s = l.strip()
        if s.startswith(NONCANON_PREFIX):
            return s, "non-canonical"
    return None, None


def in_window(at, created, lo=-BOUND_S, hi=BOUND_S):
    return lo <= ds(t(created), t(at)) <= hi


def classify(at, act, cmt, drop=None, add=None):
    """drop: action name to hide (negative control). add: synthetic row (positive control)."""
    rows = [a for a in act if a["action"] != drop]
    if add:
        rows = rows + [add(at)]
    decls = []
    for c in cmt:
        s, kind = decl(c.get("body"))
        if s:
            decls.append({"at": c["createdAt"], "kind": kind, "author": c.get("authorType"),
                          "aid": (c.get("authorAgentId") or c.get("authorUserId") or "")[:8],
                          "run": c.get("createdByRunId"), "line": s})
    if drop == "DECLS":
        decls = []
    bypass = [a for a in rows if a["action"] == BYPASS
              and (a.get("details") or {}).get("skipReason") == "board_actor_bypass"
              and in_window(at, a["createdAt"])]
    ovr = [a for a in rows if a["action"] == OVERRIDE and in_window(at, a["createdAt"])]
    near = [d for d in decls if in_window(at, d["at"], -120, BOUND_S)]
    canon = [d for d in near if d["kind"] in ("tier2", "tier1")]
    # precedence (Bug 4/Bug 6 + band #84 item 1): bypass > override > declaration
    if len(bypass) > 1:
        return ("AMBIGUOUS-bypass-rows", f"{len(bypass)} correlated board-bypass rows")
    if len(bypass) == 1:
        det = bypass[0].get("details") or {}
        return ("bypassed-at-guard", f"decisionCarried={det.get('decisionCarried')}")
    if ovr:
        d = ovr[0].get("details") or {}
        return ("overridden-by-guard", f"disposition={d.get('disposition')} "
                                       f"reason={str(d.get('overrideReason'))[:60]!r} n={len(ovr)}")
    if canon:
        d = min(canon, key=lambda x: abs(ds(t(x["at"]), t(at))))
        corr = "run-correlated" if d["run"] else "nearest-comment"
        return ("declared-close-timed", f"{d['kind']} by {d['author']}:{d['aid']} {corr} "
                                        f"d={ds(t(d['at']), t(at)):+.2f}s")
    if near:
        d = near[0]
        return ("declared-close-timed-non-canonical", f"{d['kind']} d={ds(t(d['at']), t(at)):+.2f}s")
    if decls:
        d = max(decls, key=lambda x: x["at"])
        return ("GHOST-PASS-reused-from-thread",
                f"nearest decl {ds(t(d['at']), t(at)):+.0f}s outside window")
    return ("GHOST-PASS-declaration-absent", "no declaration in thread, no correlated guard row")


def synth_override(at):
    return {"action": OVERRIDE, "createdAt": at, "entityId": "x",
            "details": {"disposition": "merged-elsewhere", "overrideReason": "SYNTHETIC CONTROL",
                        "source": "done_transition_guard"}}


def synth_stage_override(at):
    return {"action": "issue.board_stage_override", "createdAt": at, "entityId": "x",
            "details": {"decision": "approved", "stageType": "review",
                        "displacedParticipant": {"type": "agent"}}}


def flags_for(at, act):
    f = {}
    w = [a for a in act if in_window(at, a["createdAt"])]
    so = [a for a in w if a["action"] == "issue.board_stage_override"]
    if so:
        f["stage_override"] = ",".join(sorted({
            f"{a['details'].get('stageType')}/{(a['details'].get('displacedParticipant') or {}).get('type')}"
            f":{a['details'].get('decision')}" for a in so}))
    ref = [a for a in w if a["action"] == "issue.done_transition_refused"]
    if ref:
        f["refused"] = f"{len(ref)}x:" + ",".join(sorted({str(a["details"].get("code"))[:34] for a in ref}))
    lr = [a for a in w if a["action"] == "issue.done_transition_ladder_refused"]
    rr = [a for a in w if a["action"] == "issue.done_transition_ladder_refusal_repeated"]
    if lr or rr:
        f["ladder"] = f"refused={len(lr)} repeated={len(rr)}"
    ma = [a for a in w if a["action"] == "issue.merge_arming_refused_on_close"]
    if ma:
        f["merge_arm_refused"] = f"{len(ma)}x:{str(ma[0]['details'].get('refusalReason'))[:40]}"
    cs = [a for a in w if a["action"] == "issue.done_transition_cited_sha_resolved"]
    if cs:
        st = [r.get("status") for a in cs for r in (a["details"].get("results") or [])]
        f["cited_sha"] = ",".join(str(s) for s in st)
    mas = [a for a in w if a["action"] == "issue.done_missing_approval_stage_refused"]
    if mas:
        f["missing_approval_stage_refused"] = len(mas)
    # landing-backstop rows fire hourly for hours after the close: thread-scoped by design,
    # reported with their own newest timestamp so nobody reads them as close-timed.
    land = [a for a in act if a["action"] in LANDING]
    if land:
        cnt = collections.Counter(a["action"].split(".")[-1] for a in land)
        f["landing_backstop"] = ",".join(f"{k}:{v}" for k, v in sorted(cnt.items())) + \
            f" newest={max(a['createdAt'] for a in land)}"
    gn = [a for a in w if a["action"] == "issue.done_transition_guard_note"]
    if gn:
        f["guard_note"] = str(gn[0]["details"].get("skipReason"))[:40]
    tier = sorted({a["action"].split(".")[-1] for a in w
                   if a["action"] in ("issue.done_transition_tier1_close",
                                      "issue.done_transition_tier2_close",
                                      "issue.done_transition_guard_skipped")})
    f["tier_rows"] = ",".join(tier) if tier else "NONE"
    return f



# ---- band #89 addition: the shape detector passes a well-formed lie (SUP-25007). This half is
# mine: read the machine result token out of the close-timed declaration and test it against the
# outcome the SAME comment reports. Contradiction == a green record with no green evidence.
RESULT_RE = re.compile(r"(?i)(?:^|[\s`,(`])`?result`?\s*:\s*(pass|fail|clean|non-clean|partial)\b")
CONTRA = re.compile(r"(?i)(exited?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*\b|exit\s+(?:code\s+)?[1-9]\d*\b"
                    r"|rc=[1-9]\d*\b|\bnon-clean\b|failed\s+closed|failed\s+to\s+evaluate"
                    r"|all four configured repos|\bpartial failure\b|REFUSED\b|scanned=0"
                    r"|token was unavailable|credential.{0,24}(missing|unavailable)"
                    r"|evaluated\s+zero|zero\s+PRs)", re.I)


def result_truth(cmt, at, run):
    """Return (comment_id, result_token, [contradiction snippets]) for the close-timed declaration."""
    cands = []
    for c in cmt:
        s, kind = decl(c.get("body"))
        if not s:
            continue
        if not in_window(at, c["createdAt"], -120, BOUND_S):
            continue
        if run and c.get("createdByRunId") == run:
            cands.append((0, c))
        else:
            cands.append((1, c))
    if not cands:
        return None, None, []
    cands.sort(key=lambda x: (x[0], abs(ds(t(x[1]["createdAt"]), t(at)))))
    c = cands[0][1]
    body = c.get("body") or ""
    tok = None
    for m in RESULT_RE.finditer(body):
        tok = m.group(1).lower()
    hits = []
    for m in CONTRA.finditer(body):
        lo = max(0, m.start() - 90); hi = min(len(body), m.end() + 90)
        hits.append(f"[{m.group(0)}] ..." + " ".join(body[lo:hi].split()))
    return c["id"], tok, hits


def synth_contradict(c):
    d = dict(c)
    d["body"] = (c.get("body") or "") + "\n\nRESULT-CONTRA-CONTROL: the probe exited 2 and failed to evaluate all four configured repos.\n"
    return d


def main():
    snapshot = "--snapshot" in sys.argv
    cfg_path = os.path.join(HERE, "band90.json")
    if snapshot:
        band_max = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    else:
        cfg = json.load(open(cfg_path))
        band_max = cfg["BAND_MAX"]; as_filed = cfg["AS_FILED_N"]
        print(f"REPRO mode: frozen BAND_MAX={band_max} as-filed N={as_filed}")

    feed_w, pages, feed_rows = close_writes_from_feed()
    band_all = sorted([w for w in feed_w if w["at"] > PREV_EDGE], key=lambda x: x["at"])
    band = [w for w in band_all if w["at"] <= band_max]
    later = [w for w in band_all if w["at"] > band_max]
    band_ids = {w["id"] for w in band}
    popA, pagesA = population_a(band_max)
    print(f"band lower edge (probe #89 discharge, exclusive): {PREV_EDGE}")
    print(f"band upper edge (inclusive snapshot): {band_max}")
    print(f"feed rows={feed_rows} pages={pages} | issues-route pages={pagesA} | close_writes_band={len(band)} "
          f"band_cards={len(band_ids)} popA_cards={len(popA)}")
    idsA = set(popA)
    only_b = sorted(band_ids - idsA); only_a = sorted(idsA - band_ids)
    resc, seen, seen_pages = cancelled_rescan(band_max)
    tail = seen if seen < 500 else (seen - 500 * (seen_pages - 1))
    print(f"|B-A|={len(only_b)} |A-B|={len(only_a)} cancelled_with_completedAt_in_band={resc} "
          f"(of {seen} cancelled rows, paged {seen_pages}x limit=500, tail={tail}<500 — SUP-21321 termination proof)")
    if snapshot:
        json.dump({"PREV_EDGE": PREV_EDGE, "BAND_MAX": band_max, "AS_FILED_N": len(band),
                   "band_write_ids": [(w["id"], w["at"]) for w in band]}, open(cfg_path, "w"), indent=1)
        print(f"snapshot frozen -> band90.json (N={len(band)}); {len(later)} closes after snapshot uncovered")
    elif len(band) != as_filed:
        print(f"REPRO MISMATCH — as-filed {as_filed}, re-derived {len(band)}"); sys.exit(1)
    else:
        print(f"as-filed population reproduced exactly: {len(band)} == {as_filed}")

    th = {eid: thread(eid) for eid in sorted(band_ids)}
    ident_of = {}
    for w in band:
        act = th[w["id"]][0]
        ident_of[w["id"]] = next((a["details"].get("identifier") for a in act
                                  if a.get("details", {}).get("identifier")), w["id"][:8])

    # --- discovery: close/guard-shaped names in the band vocabulary the classifier never reads
    SHAPED = re.compile(r"(done|tier|ladder|override|guard|refus|merge_arming|approval_stage|cited_sha)", re.I)
    vocab = collections.Counter(a["action"] for act, _ in th.values() for a in act)
    known = GUARD | FLAG
    disc = sorted(n for n in vocab if SHAPED.search(n) and n not in known
                  and not n.startswith("heartbeat."))
    print(f"band activity vocabulary: {len(vocab)} distinct names on {len(band_ids)} cards")
    print(f"DISCOVERY (close/guard-shaped, not classified): {disc if disc else 'none'}")

    # --- action-name controls (Bug 8 census-probe rule).
    # Only the window bounds may change; stepped 72 h -> 7 d -> 30 d because rare action names
    # (done_close_landing_escalated) do not appear in a 72 h control window at all.
    print("action-name controls (same endpoint+action, window stepped 72 h / 7 d / 30 d):")
    ctrl_fail = []
    for n in sorted(known):
        cnt = vocab.get(n, 0)
        if cnt:
            print(f"    {cnt:4d} in-band  {n}  PASS (observed in band)"); continue
        out, span_used, pg = None, None, 0
        for hours in (72, 24 * 7, 24 * 30):
            ctrl_lo = (t(band_max) - datetime.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            to = None
            while pg < 40:
                r = rows_of(get(f"/api/companies/{CID}/activity?action={n}&from={ctrl_lo}&limit=500"
                                + (f"&to={to}" if to else "")))
                pg += 1
                hits = [x for x in r if x["action"] == n]
                if hits:
                    out = max(x["createdAt"] for x in hits); span_used = f"{hours} h"; break
                if len(r) < 500:
                    break
                to = min(x["createdAt"] for x in r)
            if out:
                break
        if out is None:
            ctrl_fail.append(n)
        print(f"    {cnt:4d} in-band  {n}  control newest={out} window={span_used} pages={pg} "
              f"{'PASS' if out else 'FAIL/UNVERIFIED'}")

    sel_missing = [eid for eid, (act, _) in th.items()
                   if not any(abs(ds(t(w["at"]), t(a["createdAt"]))) <= 5
                              for w in band if w["id"] == eid for a in act)]
    no_created = [eid for eid, (act, _) in th.items()
                  if not any(a["action"] == "issue.created" for a in act)]
    print(f"selector control (thread read covers close write +/-5 s): "
          f"{'PASS' if not sel_missing else 'FAIL ' + str([ident_of.get(e, e[:8]) for e in sel_missing])}")
    print(f"creation-row completeness: {len(no_created)}/{len(band_ids)} band cards have no issue.created "
          f"(finding, not a control): {[ident_of.get(e, e[:8]) for e in no_created]}")
    if ctrl_fail or sel_missing:
        print("CONTROL FAILURE — verdict inadmissible"); sys.exit(1)

    rows_out = []
    for w in band:
        act, cmt = th[w["id"]]
        b, det = classify(w["at"], act, cmt)
        cid_, tok, hits = result_truth(cmt, w["at"], w["run"])
        contrad = bool(hits) and tok in ("pass", "clean")
        rows_out.append((ident_of[w["id"]], w["at"], w["actor"], w["run"], b, det,
                         flags_for(w["at"], act), tok, hits, contrad, cid_))
    buckets = collections.Counter(r[4] for r in rows_out)
    ghost = [r for r in rows_out if r[4].startswith("GHOST") or r[4].startswith("AMBIGUOUS")]
    contrad_rows = [r for r in rows_out if r[9]]
    contradicted = contrad_rows
    for r in contrad_rows:
        print(f"    TRUTH-CONTRADICTION {r[0]} {r[1]} result-token={r[7]} decl-comment={r[10]}")
        for h in r[8][:4]:
            print(f"        {h[:300]}")
    tok_mix = collections.Counter(str(r[7]) for r in rows_out)
    print(f"declaration result-tokens in band: {dict(tok_mix)}")
    dmax = max([abs(float(m.group(1))) for r in rows_out
                for m in [re.search(r"d=([-+0-9.]+)s", r[5])] if m] or [0.0])
    print(f"buckets: {dict(buckets)} | max |decl->close| = {dmax:.2f} s (bound {BOUND_S} s)")
    for r in rows_out:
        print(f"    {r[0]} {r[1]} actor={r[2]} {r[4]} | {r[5]} | result-token={r[7]} contradicted={r[9]}")
        print(f"        flags: {r[6]}")

    # --- controls C/D: negative (classifier must be able to fail)
    declared = [r for r in rows_out if r[4] == "declared-close-timed"]
    if declared:
        victim = [w for w in band if w["at"] == declared[0][1]][0]
        v_act, v_cmt = th[victim["id"]]
        vb, _ = classify(victim["at"], v_act, v_cmt, drop="DECLS")
        vs, vsd = classify((t(victim["at"]) + datetime.timedelta(hours=3)).isoformat().replace("+00:00", "Z"),
                           v_act, v_cmt)
        print(f"control C (declaration-removal) {declared[0][0]} -> {vb} "
              f"({'PASS' if vb.startswith('GHOST') else 'FAIL'})")
        print(f"control D (time-shift +3h) {declared[0][0]} -> {vs} ({vsd}) "
              f"({'PASS' if vs.startswith('GHOST') else 'FAIL'})")
        if not (vb.startswith("GHOST") and vs.startswith("GHOST")):
            print("NEGATIVE CONTROL FAILED — classifier cannot fail; verdict void"); sys.exit(1)
    else:
        print("control C/D: no declared close in band to falsify (N/A) — state this in the verdict")

    # --- controls E/F: the override + stage-override buckets must actually read their rows
    ov = [r for r in rows_out if r[4] == "overridden-by-guard"]
    if ov:
        t_id = [w for w in band if w["at"] == ov[0][1]][0]["id"]
        a2, c2 = th[t_id]
        eb, _ = classify(ov[0][1], a2, c2, drop=OVERRIDE)
        print(f"control E (override-row removal) {ov[0][0]} -> {eb} "
              f"({'PASS (bucket drops)' if eb != 'overridden-by-guard' else 'FAIL (row not read)'})")
    else:
        print("control E: no override row in band (N/A) — override bucket empty by measurement")
    if declared:
        t_id = [w for w in band if w["at"] == declared[0][1]][0]["id"]
        a2, c2 = th[t_id]
        fb, _ = classify(declared[0][1], a2, c2, add=synth_override)
        print(f"control F (synthetic override injection) {declared[0][0]} -> {fb} "
              f"({'PASS' if fb == 'overridden-by-guard' else 'FAIL (injection ignored)'})")
        fl0 = flags_for(declared[0][1], a2)
        fl1 = flags_for(declared[0][1], a2 + [synth_stage_override(declared[0][1])])
        ok = ("stage_override" not in fl0) and fl1.get("stage_override")
        print(f"control G (synthetic stage-override injection) flags {'ABSENT->PRESENT' if ok else 'NOT DISCRIMINATED'} "
              f"({'PASS' if ok else 'FAIL'})")
        if fb != "overridden-by-guard" or not ok:
            print("OVERRIDE-CLASSIFIER CONTROL FAILED — blind spot persists; verdict void"); sys.exit(1)

    # --- controls H/I: the truth check must fire on a contradiction and stay silent without one
    declared_t = [r for r in rows_out if r[4] == "declared-close-timed" and r[7] in ("pass", "clean")]
    if declared_t:
        vid = [w for w in band if w["at"] == declared_t[0][1]][0]["id"]
        a3, c3 = th[vid]
        cid3, tok3, hits3 = result_truth(c3, declared_t[0][1], declared_t[0][3] if len(declared_t[0]) > 3 else None)
        tgt = next(c for c in c3 if c["id"] == cid3)
        cid4, tok4, hits4 = result_truth([synth_contradict(tgt) if c["id"] == cid3 else c
                                          for c in c3], declared_t[0][1], None)
        ok_h = bool(hits4) and tok4 in ("pass", "clean") and not any("RESULT-CONTRA-CONTROL" in h for h in hits3)
        print(f"control H (synthetic contradiction injection) {declared_t[0][0]} token={tok4} "
              f"hits={len(hits4)} baseline_hits={len(hits3)} "
              f"({'PASS' if ok_h else 'FAIL (truth check cannot fire)'})")
        stripped = [{**c, "body": re.sub(RESULT_RE, "", c.get("body") or "")} if c["id"] == cid3 else c
                    for c in c3]
        cid5, tok5, hits5 = result_truth(stripped, declared_t[0][1], None)
        print(f"control I (result-token removal) {declared_t[0][0]} token->{tok5!r} "
              f"({'PASS (token read, not guessed)' if tok5 is None else 'FAIL (token survived stripping)'})")
        if not (ok_h and tok5 is None):
            print("TRUTH-CHECK CONTROL FAILED — contradiction reading is not trustworthy; verdict void"); sys.exit(1)
    else:
        print("control H/I: no declared close carrying a result token in band (N/A) — state this in the verdict")

    tier_missing = [r[0] for r in rows_out if r[6].get("tier_rows") == "NONE"]
    print(f"tier-row presence: {len(rows_out)-len(tier_missing)}/{len(rows_out)} closes emitted a tier/guard_skipped row; "
          f"no row: {tier_missing}")
    old = [r for r in rows_out if r[1] < PROCESS_START]
    new = [r for r in rows_out if r[1] >= PROCESS_START]
    print(f"build era split at PROCESS_START {PROCESS_START} (serve89.py, pid 8): "
          f"pre-restart closes={len(old)} post-restart closes={len(new)}")
    for label, grp in (("pre-restart", old), ("post-restart", new)):
        if not grp:
            print(f"    {label}: none")
            continue
        nt = sum(1 for r in grp if r[6].get("tier_rows") != "NONE")
        print(f"    {label}: {nt}/{len(grp)} emitted a tier/guard_skipped row; "
              f"no row: {[r[0] for r in grp if r[6].get('tier_rows') == 'NONE']}")
    dr = {k: sum(1 for i in band_ids if (popA.get(i) or {}).get("deliveryRequirement") == k)
          for k in ("record_only", "repository_delivery")}
    print(f"dr mix in band: {dr}")
    print(f"ghost_pass={len(ghost)} truth_contradicted={len(contradicted)} undetermined={len([r for r in rows_out if r[4].startswith('AMBIGUOUS')])}")
    if ghost or contradicted:
        print("VERDICT: FAIL"); sys.exit(1)
    print(f"VERDICT: PASS — 0 ghost-PASS and 0 truth-contradicted of {len(band)} band close writes; band_cards={len(band_ids)} "
          f"popA={len(idsA)} dmax={dmax:.2f}s; {len(later)} later closes uncovered")


main()
