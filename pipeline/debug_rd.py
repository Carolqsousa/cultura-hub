import urllib.request
import json
import os

TOKEN = os.environ.get("RD_STATION_API_KEY", "YOUR_TOKEN_HERE")
BASE  = "https://crm.rdstation.com/api/v1"

def req(path, params=""):
    # RD Station CRM uses token as query param
    sep = "&" if "?" in params else "?"
    url = BASE + path + params + sep + f"token={TOKEN}"
    r = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(r, timeout=20) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code}: {body[:300]}")
        return None
    except Exception as e:
        print(f"Error: {e}")
        return None

print("=== GET /deals ===")
d = req("/deals", "?page=1&limit=3")
if d:
    print(f"Keys: {list(d.keys())}")
    deals = d.get("deals") or d.get("data") or []
    if deals:
        print(f"First deal keys: {list(deals[0].keys())}")
        print(json.dumps(deals[0], ensure_ascii=False, indent=2)[:1000])
    print(f"Total: {d.get('total')}")

print()
print("=== GET /deal_stages ===")
s = req("/deal_stages")
if s:
    print(json.dumps(s, ensure_ascii=False, indent=2)[:600])

print()
print("=== GET /activities ===")
a = req("/activities", "?page=1&limit=3")
if a:
    print(f"Keys: {list(a.keys())}")
    acts = a.get("activities") or a.get("data") or []
    if acts:
        print(f"First activity keys: {list(acts[0].keys())}")
        print(json.dumps(acts[0], ensure_ascii=False, indent=2)[:600])

print()
print("=== GET /users ===")
u = req("/users")
if u:
    print(json.dumps(u, ensure_ascii=False, indent=2)[:400])
