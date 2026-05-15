import urllib.request, json, os

TOKEN = os.environ.get("RD_STATION_API_KEY", "")
BASE  = "https://crm.rdstation.com/api/v1"

def req(path, params=""):
    sep = "&" if "?" in params else "?"
    url = BASE + path + params + sep + f"token={TOKEN}"
    with urllib.request.urlopen(urllib.request.Request(url), timeout=20) as res:
        return json.loads(res.read().decode())

# get deals with source and loss reason
d = req("/deals", "?page=1&limit=200&win=false")
found_source = 0
found_perda = 0

for deal in d["deals"]:
    source = deal.get("deal_source", {})
    if source and source.get("name") and source["name"] != "Desconhecido":
        if found_source < 3:
            print(f"FONTE: {source['name']} — {deal['name']}")
            found_source += 1

    for cf in deal.get("deal_custom_fields", []):
        label = cf.get("custom_field", {}).get("label", "")
        value = cf.get("value", "")
        if "perda" in label.lower() or "motivo" in label.lower() or "perda" in label.lower():
            if found_perda < 5:
                print(f"PERDA FIELD: {label} = {value} — {deal['name']}")
                found_perda += 1

# also check deal_lost_reason
print("\n=== checking deal_lost_reason field ===")
for deal in d["deals"][:10]:
    keys = list(deal.keys())
    lr = deal.get("deal_lost_reason") or deal.get("lost_reason")
    if lr:
        print(f"lost_reason: {lr} — {deal['name']}")
    print(f"  keys: {[k for k in keys if 'lost' in k or 'perda' in k or 'reason' in k]}")
    break
