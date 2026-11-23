#!/usr/bin/env python3
"""Bug 7 serving-identity re-measure for band #90: process probe (argv0 via `ps -o args=`,
lstart before AND after the health call) + authoritative disk stamp, deploy gap against the live
fold ref, then per-fix ancestry on MERGE COMMITS (band #84's head-SHA test was wrong; corrected
in band #85). Also resolves each repo's default branch live (Bug 1)."""
import json, os, subprocess, urllib.request, re, sys

BASE = os.environ["PAPERCLIP_API_URL"]
TOK = os.environ["PAPERCLIP_API_KEY"]
REPO = "TEA-Core/paperclip"
FIXES = {"01b298eb3fde": "#1174 write tier close rows on the terminal write (merge commit)",
         "4c1e4e0e5238": "#1253 self-referential retry lineage (merge commit)",
         "01e1f57640db": "#1254 drain detached stage wakes (merge commit)",
         "d36c8d379bc5": "#1245 one instruction consent per write request (merge commit)"}


def gh(*a):
    p = subprocess.run(["gh"] + list(a), capture_output=True, text=True, timeout=180)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def health():
    rq = urllib.request.Request(BASE + "/api/health", headers={"Authorization": f"Bearer {TOK}"})
    r = urllib.request.urlopen(rq, timeout=60)
    return r.status, json.loads(r.read())


def pid_of():
    pids = []
    for line in subprocess.run(["pgrep", "-f", "server/dist/index.js"], capture_output=True,
                               text=True).stdout.split():
        exe = subprocess.run(["readlink", "-f", f"/proc/{line}/exe"],
                             capture_output=True, text=True).stdout.strip()
        argv0 = (subprocess.run(["ps", "-o", "args=", "-p", line], capture_output=True,
                                text=True).stdout.split() or [""])[0]
        name = os.path.basename(exe) or os.path.basename(argv0)
        if name.startswith("node") or name.startswith("tsx"):
            pids.append((int(line), f"exe={exe or 'UNREADABLE'} argv0={argv0}"))
    return pids


def lstart(pid):
    return subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)],
                          capture_output=True, text=True).stdout.strip()


rc, db, _ = gh("api", f"repos/{REPO}", "--jq", ".default_branch")
print(f"default_branch({REPO}) resolved live = {db}")

pids = pid_of()
print(f"candidate server pids: {pids}")
if len(pids) != 1:
    print("process identity FATAL — pid unresolvable/ambiguous; no serving verdict permitted"); sys.exit(1)
pid = pids[0][0]
pre = lstart(pid)
st, h = health()
post = lstart(pid)
etime = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
print(f"pid={pid} lstart_pre={pre} lstart_post={post} stable={pre == post and bool(pre)} etime={etime}")
print(f"GET /api/health -> HTTP {st} commit={h.get('commit')} version={h.get('version')}")
if not (pre == post and pre):
    print("process capture unstable — process identity UNKNOWN"); sys.exit(1)
if st != 200 or not re.fullmatch(r"[0-9a-f]{40}", str(h.get("commit") or "")):
    print("health identity INVALID — process identity UNKNOWN"); sys.exit(1)

try:
    disk = json.load(open("/app/server/dist/build-info.json"))
    dc = disk.get("commit") or ""
    mt = subprocess.run(["stat", "-c", "%y", "/app/server/dist/build-info.json"],
                        capture_output=True, text=True).stdout.strip()
    print(f"disk authoritative stamp /app/server/dist/build-info.json commit={dc} mtime={mt} full={disk}")
    same = (dc == h.get("commit"))
    print(f"identity model: {'SINGLE (disk == health)' if same else 'SPLIT -> rollout pending'}")
except Exception as e:
    dc = None
    print(f"disk authoritative stamp UNREADABLE ({type(e).__name__}: {e}) -> disk identity UNKNOWN; "
          f"'serving'/'rollout pending'/'not shipped' all prohibited")

rc, tip, err = gh("api", f"repos/{REPO}/commits/{db}", "--jq", ".sha")
print(f"{db} tip={tip} {err[:80]}")
rc2, tb, _ = gh("api", f"repos/{REPO}/compare/{h['commit']}...{db}", "--jq",
                '{behind: .behind_by, ahead: .ahead_by, status: .status}')
print(f"serving..{db}: {tb}")
for sha, label in FIXES.items():
    rcx, ox, _ = gh("api", f"repos/{REPO}/compare/{sha}...{db}", "--jq", ".behind_by")
    rcy, oy, _ = gh("api", f"repos/{REPO}/compare/{sha}...{h['commit']}", "--jq", ".behind_by")
    in_fold = (rcx == 0 and ox.strip() == "0")
    in_serve = (rcy == 0 and oy.strip() == "0")
    print(f"  {sha} {label}: in_default={in_fold}(behind_by={ox}) in_serving={in_serve}(behind_by={oy}) "
          f"-> {'DEPLOYED' if in_serve else 'MERGED-NOT-SERVING' if in_fold else 'NOT-IN-DEFAULT'}")
print("\nDONE")
