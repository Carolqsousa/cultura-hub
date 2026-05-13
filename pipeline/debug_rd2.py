import urllib.request
import json
import os

TOKEN = os.environ.get("RD_STATION_API_KEY", "YOUR_TOKEN_HERE")
BASE  = "https://crm.rdstation.com/api/v1"

def req(path, params=""):
    sep = "&" if "?" in params else "?"
    url = BASE + path + params + sep + f"token={TOKEN}"
    r = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(r, timeout=20) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:200]}")
        return None

# All deal stages
print("=== ALL DEAL STAGES ===")
s = req("/deal_stages")
if s:
    for stage in s.get("deal_stages", []):
        print(f"  {stage['order']}. {stage['name']} (id: {stage['id']})")

print()

# Tasks endpoint
print("=== GET /tasks ===")
t = req("/tasks", "?page=1&limit=3")
if t:
    print(f"Keys: {list(t.keys())}")
    tasks = t.get("tasks") or t.get("data") or []
    if tasks:
        print(f"First task keys: {list(tasks[0].keys())}")
        print(json.dumps(tasks[0], ensure_ascii=False, indent=2)[:800])
    print(f"Total: {t.get('total')}")

print()

# Deals with win=true (converted)
print("=== DEALS WON (sample) ===")
w = req("/deals", "?win=true&page=1&limit=2")
if w:
    print(f"Total won: {w.get('total')}")
    deals = w.get("deals", [])
    if deals:
        d = deals[0]
        print(f"  stage: {d.get('deal_stage', {}).get('name')}")
        print(f"  win: {d.get('win')}, closed_at: {d.get('closed_at')}")

print()

# Deals lost
print("=== DEALS LOST (sample) ===")
l = req("/deals", "?win=false&page=1&limit=2")
if l:
    print(f"Total lost: {l.get('total')}")
