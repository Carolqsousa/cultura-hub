import logging, os
from bigquery.client import ensure_table, upsert_rows
from sponte_client import SponteClient
from sponte.diary_check import fetch as fetch_diary

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

branches = [
    {"name": "Boa Viagem", "api_key": os.environ.get("SPONTE_API_KEY_BOA_VIAGEM", "")},
    {"name": "Young",      "api_key": os.environ.get("SPONTE_API_KEY_YOUNG", "")},
    {"name": "Setubal",    "api_key": os.environ.get("SPONTE_API_KEY_SETUBAL", "")},
    {"name": "Natal",      "api_key": os.environ.get("SPONTE_API_KEY_NATAL", "")},
]

for branch in branches:
    if not branch["api_key"]:
        log.warning(f"No API key for {branch['name']}, skipping")
        continue
    log.info(f"=== {branch['name']} ===")
    os.environ["SPONTE_BRANCH_CURRENT"] = branch["name"]
    sponte = SponteClient(api_key=branch["api_key"], branch_name=branch["name"])
    try:
        ensure_table("diary_checks")
        rows = fetch_diary(sponte)
        upsert_rows("diary_checks", rows)
        log.info(f"diary_checks: {len(rows)} rows written")
    except Exception:
        log.exception(f"diary_checks FAILED for {branch['name']}")
