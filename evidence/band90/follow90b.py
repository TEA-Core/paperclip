import json,os,re,urllib.request,datetime
BASE=os.environ["PAPERCLIP_API_URL"];TOK=os.environ["PAPERCLIP_API_KEY"];CID=os.environ["PAPERCLIP_COMPANY_ID"]
def get(p):
    rq=urllib.request.Request(BASE+p,headers={"Authorization":f"Bearer {TOK}"})
    return json.loads(urllib.request.urlopen(rq,timeout=180).read())
def rows_of(r): return r if isinstance(r,list) else (r.get("activity") or r.get("rows") or [])

# 1. SUP-25007 (F89-1 canonical anchor): status + run history since filing
i=get("/api/issues/SUP-25007")
print("SUP-25007 status=",i["status"],"dr=",i.get("deliveryRequirement"),"assignee=",i.get("assigneeAgentId"),"created=",i["createdAt"])
try:
    runs=rows_of(get(f"/api/issues/{i['id']}/runs"))
    for r in runs: print("   run", r.get("id","")[:8], r.get("agentId","")[:8] if r.get("agentId") else "-", r.get("createdAt"), r.get("finishedAt") or r.get("status"))
except Exception as e: print("   runs fetch:",e)

# 1b. SUP-22919 candidate concurrent arch-review on the signature
j=get("/api/issues/SUP-22919")
print("SUP-22919 status=",j["status"],"title=",j["title"])
print("   body head:", (j.get("description") or "")[:900].replace("\n"," | "))

# 1c. SUP-25027 arch review: blocked why
k=get("/api/issues/SUP-25027")
print("SUP-25027 status=",k["status"],"assignee=",k.get("assigneeAgentId"),"blockedTransitionAt=",k.get("blockedTransitionAt"))
ka=rows_of(get(f"/api/issues/{k['id']}/activity?limit=100"))
for a in ka:
    if a["action"]=="issue.updated" and ((a.get("details") or {}).get("changes") or {}).get("status"):
        ch=a["details"]["changes"]["status"]; print("   status",ch.get("from"),"->",ch.get("to"),a["createdAt"],a.get("actorType"))
for a in ka:
    if a["action"]=="issue.comment_added" and a.get("actorType")=="agent":
        pass
last=[c for c in rows_of(get(f"/api/issues/{k['id']}/comments?limit=20"))]
if last: print("   last comment by",last[-1].get("authorType"),":",((last[-1].get("body") or "")[:400]).replace("\n"," | "))

# 2. cited_sha_resolved rows on SUP-25026 / SUP-25040: read details.results[].status
for ident in ("SUP-25026","SUP-25040"):
    ii=get(f"/api/issues/{ident}")
    for a in rows_of(get(f"/api/issues/{ii['id']}/activity?limit=500")):
        if a["action"]=="issue.done_transition_cited_sha_resolved":
            print(f"{ident} cited_sha_resolved {a['createdAt']} results:",json.dumps((a.get('details') or {}).get('results'))[:400])

# 3. ladder refusals on card 2755ef7c and any other card since 2026-11-22T16:18Z (band) and 11-22T00:00Z (day)
lo=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=24)
lo_s=lo.strftime("%Y-%m-%dT%H:%M:%S.000Z")
for name in ("issue.done_transition_ladder_refused","issue.done_transition_ladder_refusal_repeated"):
    r=rows_of(get(f"/api/companies/{CID}/activity?action={name}&from={lo_s}&limit=500"))
    cnt={}
    for a in r: cnt[a.get("entityId","")[:8]]=cnt.get(a.get("entityId","")[:8],0)+1
    print(f"{name} last 24h rows={len(r)} per-card(top)={dict(sorted(cnt.items(),key=lambda x:-x[1])[:5])}")

# 4. cleanup_failed rate last 2h; feed retention (oldest feed row)
now=datetime.datetime.now(datetime.timezone.utc)
cf=rows_of(get(f"/api/companies/{CID}/activity?action=execution_workspace.issue_terminal_cleanup_failed&from={(now-datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3][:-4+0]}Z&limit=500"))
print("cleanup_failed rows last 2h:",len(cf),"(single page tail<500 =",len(cf)<500,")")
feed=rows_of(get(f"/api/companies/{CID}/activity?limit=500"))
old=rows_of(get(f"/api/companies/{CID}/activity?limit=500&offset=0"))
# retention: page back until empty
off=0; oldest=None; pages=0
while pages<60:
    r=rows_of(get(f"/api/companies/{CID}/activity?limit=500&offset={off}"))
    pages+=1
    if not r: break
    oldest=min(x["createdAt"] for x in r)
    if len(r)<500: break
    off+=500
print(f"feed oldest row={oldest} rows~{off+len(r)} pages={pages} retention_h={(now-datetime.datetime.fromisoformat(oldest.replace('Z','+00:00'))).total_seconds()/3600:.1f}")
