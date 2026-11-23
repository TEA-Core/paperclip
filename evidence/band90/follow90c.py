import json,os,urllib.request,datetime,collections
BASE=os.environ["PAPERCLIP_API_URL"];TOK=os.environ["PAPERCLIP_API_KEY"];CID=os.environ["PAPERCLIP_COMPANY_ID"]
def get(p):
    rq=urllib.request.Request(BASE+p,headers={"Authorization":f"Bearer {TOK}"})
    return json.loads(urllib.request.urlopen(rq,timeout=180).read())
def rows_of(r): return r if isinstance(r,list) else (r.get("activity") or r.get("rows") or [])
LO="2026-11-22T16:18:57.006Z"
# A. board_stage_override since band edge: which cards, and did their closes emit tier rows?
so=rows_of(get(f"/api/companies/{CID}/activity?action=issue.board_stage_override&from={LO}&limit=500"))
cards=collections.Counter(a.get("entityId","") for a in so)
print(f"board_stage_override rows since {LO}: {len(so)} on {len(cards)} cards")
for eid,n in cards.most_common():
    acts=rows_of(get(f"/api/issues/{eid}/activity?limit=500"))
    tier=[a["action"].split(".")[-1] for a in acts if a["action"] in ("issue.done_transition_tier1_close","issue.done_transition_tier2_close","issue.done_transition_guard_skipped")]
    done=[a for a in acts if a["action"]=="issue.updated" and ((a.get("details") or {}).get("changes") or {}).get("status",{}).get("to")=="done"]
    st=next(((a.get("details") or {}).get("identifier") for a in acts if (a.get("details") or {}).get("identifier")),eid[:8])
    print(f"   {st}: override_rows={n} closed={'yes' if done else 'no'} tier_rows={tier if tier else 'NONE'}")

# B. cleanup_failed action-name control: newest row in 7d
now=datetime.datetime.now(datetime.timezone.utc)
for hours in (72,168,720):
    lo=(now-datetime.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    r=rows_of(get(f"/api/companies/{CID}/activity?action=execution_workspace.issue_terminal_cleanup_failed&from={lo}&limit=500"))
    print(f"cleanup_failed control {hours}h: rows={len(r)} newest={max((x['createdAt'] for x in r),default='none')} oldest={min((x['createdAt'] for x in r),default='none')}")
    if r: break
# C. last-24h cleanup_failed count
lo=(now-datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
r=rows_of(get(f"/api/companies/{CID}/activity?action=execution_workspace.issue_terminal_cleanup_failed&from={lo}&limit=500"))
print(f"cleanup_failed last 24h rows={len(r)} (tail<500={len(r)<500})")
# D. ladder card 2755ef7c identity
i=get("/api/issues/2755ef7c-043c-4db3-a2a1-9ee4c49e6d6a")
print("ladder card:",i["identifier"],i["status"],i["title"][:100])
