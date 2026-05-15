import urllib.request, json, os

TOKEN = os.environ.get("RD_STATION_API_KEY", "")
BASE  = "https://crm.rdstation.com/api/v1"

def req(path, params=""):
    sep = "&" if "?" in params else "?"
    url = BASE + path + params + sep + f"token={TOKEN}"
    with urllib.request.urlopen(urllib.request.Request(url), timeout=20) as res:
        return json.loads(res.read().decode())

# get a lost deal to see perda fields
lost = req("/deals", "?page=1&limit=3&win=false")
for deal in lost["deals"]:
    print(f"\n=== {deal['name']} ===")
    print(f"source: {deal.get('deal_source', {}).get('name')}")
    print(f"campaign: {deal.get('campaign', {}).get('name')}")
    print("custom fields:")
    for cf in deal.get("deal_custom_fields", []):
        label = cf.get("custom_field", {}).get("label", "")
        value = cf.get("value", "")
        print(f"  {label}: {value}")
