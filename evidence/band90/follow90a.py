import json,os,re,urllib.request,collections,datetime
BASE=os.environ["PAPERCLIP_API_URL"];TOK=os.environ["PAPERCLIP_API_KEY"];CID=os.environ["PAPERCLIP_COMPANY_ID"]
def get(p):
    rq=urllib.request.Request(BASE+p,headers={"Authorization":f"Bearer {TOK}"})
    return json.loads(urllib.request.urlopen(rq,timeout=180).read())
def rows_of(r): return r if isinstance(r,list) else (r.get("activity") or r.get("rows") or [])

# 1. full declaration bodies for the 8 detector hits: extract machine exit codes
HITS=["SUP-25026","SUP-25029","SUP-25030","SUP-25031","SUP-25035","SUP-25036","SUP-25037","SUP-25040"]
DECL={"SUP-25026":"6d099f28-40c1-4fd7-95f3-b3978a19cb86","SUP-25029":"071fbd63-9d1c-4854-87f3-73b2322ee624",
"SUP-25030":"9d4af635-ab05-4c00-a129-5e94d03e8ff3","SUP-25031":"f0d7f61b-cbdd-48e6-807b-9d35505c017b",
"SUP-25035":"f83c8918-3ae4-4276-8792-a031364b485d","SUP-25036":"4b0b220b-c546-4945-8144-2472fb600bd6",
"SUP-25037":"ac8d3a97-a183-414a-a24d-6788d7bb316f","SUP-25040":"98dfc7e1-e0ea-4645-a3ad-f13369381b2c"}
for ident,cid_ in DECL.items():
    i=get(f"/api/issues/{ident}")
    c=next(c for c in rows_of(get(f"/api/issues/{i['id']}/comments?limit=60")) if c["id"]==cid_)
    b=c.get("body") or ""
    exits=sorted(set(re.findall(r"exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?(\d+)",b,re.I)))
    scanned=re.findall(r"scanned=(\d+)",b); failed=re.findall(r"failed=(\d+)",b)
    print(f"{ident} decl {cid_[:8]} author={c.get('authorType')}:{(c.get('authorAgentId') or '')[:8]} run={c.get('createdByRunId') and 'yes' or 'no'}")
    print(f"   exit codes seen: {exits} | scanned={scanned} failed={failed} | len={len(b)}")
    # does a result: pass coexist with exit>=1 in the SAME comment
    has_pass=bool(re.search(r"result:\s*pass",b,re.I)); hard=any(int(x)>0 for x in exits)
    print(f"   result:pass={has_pass} hard_machine_failure={hard}")
    # print lines containing 'exit'
    for l in b.split("\n"):
        if re.search(r"exit",l,re.I): print("   LINE:",l.strip()[:220])
