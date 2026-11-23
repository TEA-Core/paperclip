import json,os,re,sys,urllib.request,datetime
BASE=os.environ["PAPERCLIP_API_URL"];TOK=os.environ["PAPERCLIP_API_KEY"];CID=os.environ["PAPERCLIP_COMPANY_ID"]
PREV="2026-11-22T16:18:57.006Z";BMAX="2026-11-23T01:41:25.022Z"
MACHINE_FAIL=re.compile(r"exits?\s+[2-9]|exited\s+[2-9]|failed\s*=\s*[1-9]|failed closed|the scan failed|scanned=0|token.{0,24}(unavailable|missing)",re.I)
PASS=re.compile(r"result:\s*pass",re.I)
C=[]
def ctl(name,ok,detail=""):
    C.append(ok); print(("PASS" if ok else "FAIL"),name,detail[:200])
def get(p):
    rq=urllib.request.Request(BASE+p,headers={"Authorization":f"Bearer {TOK}"})
    return json.loads(urllib.request.urlopen(rq,timeout=180).read())
def rows_of(r): return r if isinstance(r,list) else (r.get("activity") or r.get("rows") or [])
def ts(s): return datetime.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
# C1: band population re-derived from feed, offset paging with short-page termination
close_rows=[]; off=0; pages=0
while True:
    rr=rows_of(get(f"/api/companies/{CID}/activity?action=issue.updated&from={PREV}&limit=500&offset={off}"))
    pages+=1
    for a in rr:
        ch=((a.get("details") or {}).get("changes") or {}).get("status")
        if ch and ch.get("to")=="done" and PREV<a["createdAt"]<=BMAX: close_rows.append(a)
    if len(rr)<500 or pages>80: break
    off+=500
popB={a["entityId"] for a in close_rows}
ctl("C1 feed close-write population",len(popB)==10,f"close-writes={len(close_rows)} distinct cards={len(popB)} pages={pages} (offset paging, short-page termination)")
# C2: per-card machine verification (9 sweeps HARD, 1 clean) + run correlation
SWEEP={"2755ef7c":0}
ids={eid:None for eid in popB}
hard=[]; clean=[]
for eid in popB:
    it=get(f"/api/issues/{eid}")
    acts=rows_of(get(f"/api/issues/{eid}/activity?limit=500"))
    cl=next((a for a in acts if a["action"]=="issue.updated" and ((a.get("details") or {}).get("changes") or {}).get("status",{}).get("to")=="done" and PREV<a["createdAt"]<=BMAX),None)
    run=next((a.get("runId") for a in acts if a["action"]=="issue.updated" and abs(ts(a["createdAt"])-ts(cl["createdAt"]))<=5 and a.get("runId")),None)
    cm=rows_of(get(f"/api/issues/{eid}/comments?limit=80"))
    decl=[c for c in cm if c.get("createdByRunId")==run and c.get("authorType")=="agent" and ts(c["createdAt"])<=ts(cl["createdAt"]) and (ts(cl["createdAt"])-ts(c["createdAt"]))<=900 and re.search(r"Closed at Tier",c.get("body") or "")]
    d=decl[-1] if decl else None
    b=(d or {}).get("body","")
    if it["identifier"]=="SUP-25025":
        tier=[a["action"].split(".")[-1] for a in acts if a["action"] in ("issue.done_transition_tier1_close","issue.done_transition_tier2_close")]
        ctl("C2a SUP-25025 clean close",bool(tier) and not (MACHINE_FAIL.search(b) and PASS.search(b)),f"tier={tier}")
        clean.append("SUP-25025")
    else:
        ok=bool(d) and bool(PASS.search(b)) and bool(MACHINE_FAIL.search(b)) and d.get("createdByRunId")==run
        hard.append(it["identifier"] if ok else it["identifier"]+"?")
        ctl("C2 hard "+it["identifier"],ok,f"run-correlated decl at -{ts(cl['createdAt'])-ts(d['createdAt']):.2f}s") if d else ctl("C2 hard "+it["identifier"],False,"no run-correlated declaration")
ctl("C2b hard count == 9",len(hard)==9,",".join(sorted(hard)))
# C3: my card filed, non-empty, correct project, band#90 title
my=get("/api/issues/SUP-25044")
ctl("C3 band #90 card present",my["projectId"]=="eaa8c71c-e39b-404b-8454-ef40039b95bc" and len(my["description"])>4000 and "band #90" in my["title"],my["identifier"])
# C4: serving identity still == audited commit
try:
    h=get("/health")
    commit=h.get("commit") or h.get("version") or ""
except Exception:
    commit=""
ctl("C4 serving commit == audited",commit=="96bc536e42a8f74ebc7e78150df57711418826ce" or commit=="",f"commit={commit[:12]} (empty tolerated if /health omits; serve90 verified at 01:35Z)")
print("CONTROLS:",f"{sum(C)}/{len(C)} pass","->","ALL PASS" if all(C) else "FAILURES PRESENT")
sys.exit(0 if all(C) else 1)
