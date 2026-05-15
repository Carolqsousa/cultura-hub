import urllib.request, json, os

TOKEN = os.environ.get("RD_STATION_API_KEY", "")
BASE  = "https://crm.rdstation.com/api/v1"

def req(path, params=""):
    sep = "&" if "?" in params else "?"
    url = BASE + path + params + sep + f"token={TOKEN}"
    with urllib.request.urlopen(urllib.request.Request(url), timeout=20) as res:
        return json.loads(res.read().decode())

# get one deal with all fields
d = req("/deals", "?page=1&limit=1&win=true")
deal = d["deals"][0]
print("=== DEAL FIELDS ===")
print(json.dumps(deal, ensure_ascii=False, indent=2))
