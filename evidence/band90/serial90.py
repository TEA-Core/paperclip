#!/usr/bin/env python3
"""Bug 8 serial derivation, re-derived fresh at this wake (band #88 pre-flight).
Contract: GET /api/companies/<cid>/issues?limit=50 -> parse `wake audit #N` EXCLUDING titles
containing `targeted probe` -> max+1. No in-window claimant => `serial: underivable`, STOP.
Also reports what decides census-vs-probe: SUP-24929 (the latch fix), the chain edge
(SUP-24727 / #79), and the open findings carried from band #88.
"""
import json, os, re, urllib.request

CID = os.environ["PAPERCLIP_COMPANY_ID"]
TOK = os.environ["PAPERCLIP_API_KEY"]; BASE = os.environ["PAPERCLIP_API_URL"]
LAST_CENSUS = "SUP-24727"                     # #79, last card that published a chain boundary
CHAIN_EDGE = "2026-11-19T14:07:20.178Z"       # #79's last covered close (chain stays latched)
LAST_PROBE_EDGE = "2026-11-22T07:03:47.346Z"  # #88 audited upper edge (band #89 lower edge)


def get(p):
    rq = urllib.request.Request(BASE + p, headers={"Authorization": f"Bearer {TOK}"})
    return json.loads(urllib.request.urlopen(rq, timeout=180).read())


def rows(x):
    return x if isinstance(x, list) else (x.get("issues") or x.get("rows") or [])


SER = re.compile(r"wake audit #(\d+)", re.I)
win = rows(get(f"/api/companies/{CID}/issues?limit=50"))
print(f"freshest-window size: {len(win)}")
ts = sorted(r.get("createdAt") or "" for r in win)
print(f"freshest-window span (createdAt): {ts[0]} .. {ts[-1]}")
claim = sorted({(int(SER.search(r["title"]).group(1)), r["identifier"], r["status"])
                for r in win if SER.search(r["title"] or "")
                and "targeted probe" not in (r["title"] or "").lower()})
probes = [(r["identifier"], r["status"]) for r in win
          if "targeted probe" in (r["title"] or "").lower()]
print(f"non-probe `wake audit #N` claimants in window ({len(claim)}): {claim}")
print(f"targeted-probe cards consuming window slots ({len(probes)}): {[p[0] for p in probes]}")
if claim:
    n = max(c[0] for c in claim) + 1
    coll = [c for c in claim if c[0] == n]
    print(f"DERIVED serial: {n}  collision check: {coll if coll else 'none'}")
else:
    print("serial: underivable  (no in-window non-probe `wake audit #N` claimant) -> no census card may be minted")

for ident in ("SUP-24929", LAST_CENSUS, "SUP-24950", "SUP-24983", "SUP-24984", "SUP-25007", "SUP-25002", "SUP-24994", "SUP-24136", "SUP-22919", "SUP-22839", "SUP-23801"):
    i = get("/api/issues/" + ident)
    print(f"{ident}: status={i.get('status')} completedAt={i.get('completedAt')} "
          f"assigneeUser={i.get('assigneeUserId')} dr={i.get('deliveryRequirement')} "
          f"title={(i.get('title') or '')[:70]}")

d = rows(get(f"/api/companies/{CID}/issues?status=done&limit=1000&completedAfter={CHAIN_EDGE}"))
print(f"done-cards closed after CHAIN_EDGE {CHAIN_EDGE}: {len(d)} "
      f"(newest={d[0]['completedAt'] if d else None} oldest={d[-1]['completedAt'] if d else None})")
d2 = rows(get(f"/api/companies/{CID}/issues?status=done&limit=1000&completedAfter={LAST_PROBE_EDGE}"))
print(f"done-cards closed after LAST_PROBE_EDGE {LAST_PROBE_EDGE}: {len(d2)} "
      f"(newest={d2[0]['completedAt'] if d2 else None} oldest={d2[-1]['completedAt'] if d2 else None})")
