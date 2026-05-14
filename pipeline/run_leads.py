import logging
from bigquery.client import ensure_table, upsert_rows
from rd_station_client import RDStationClient
from rd_station.leads import fetch as fetch_leads

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

rd = RDStationClient()
try:
    ensure_table("leads")
    rows = fetch_leads(rd)
    upsert_rows("leads", rows)
    log.info(f"leads: {len(rows)} rows written")
except Exception:
    log.exception("leads FAILED")
