"""Daily pipeline entry point — runs all sources and writes to BigQuery."""

import logging

from bigquery.client import ensure_table, upsert_rows

# Sponte modules
from sponte import students, financials, attendance, grades, cancellations
from sponte.diary_check import fetch as fetch_diary

# RD Station modules
from rd_station import leads

# Google Sheets modules
from google_sheets import goals, todos, teacher_attendance, nps

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def run():
    # Import clients here so credentials are only loaded at runtime
    import os
    from sponte_client import SponteClient          # your existing script
    from rd_station_client import RDStationClient   # TODO: implement
    from sheets_client import GoogleSheetsClient    # TODO: implement

    branches = [
        {"name": "Boa Viagem", "api_key": os.environ.get("SPONTE_API_KEY_BOA_VIAGEM", "")},
        {"name": "Young",      "api_key": os.environ.get("SPONTE_API_KEY_YOUNG", "")},
        {"name": "Setubal",    "api_key": os.environ.get("SPONTE_API_KEY_SETUBAL", "")},
        {"name": "Natal",      "api_key": os.environ.get("SPONTE_API_KEY_NATAL", "")},
    ]

    semester = os.environ.get("SPONTE_SEMESTER", "")
    start    = os.environ.get("SPONTE_START", "")
    end      = os.environ.get("SPONTE_END", "")

    rd = RDStationClient()
    sheets = GoogleSheetsClient()

    # --- Sponte fetchers: run once per branch with a dedicated client ---
    sponte_fetchers = [
        # (table_name,      fetch_fn)
        ("students",        students.fetch),
        ("financials",      financials.fetch),
        ("attendance",      attendance.fetch),
        ("grades",          grades.fetch),
        ("cancellations",   cancellations.fetch),
        ("diary_checks",    fetch_diary),
    ]

    for branch in branches:
        branch_name = branch["name"]
        if not branch["api_key"]:
            log.warning(f"=== Branch: {branch_name} — no API key set, skipping ===")
            continue
        log.info(f"=== Branch: {branch_name} ===")
        sponte = SponteClient(api_key=branch["api_key"], branch_name=branch_name)

        for table_name, fetch_fn in sponte_fetchers:
            log.info(f"  Starting {table_name} [{branch_name}]...")
            try:
                ensure_table(table_name)
                rows = fetch_fn(sponte)
                upsert_rows(table_name, rows)
                log.info(f"    {table_name} [{branch_name}]: {len(rows)} rows written")
            except Exception:
                log.exception(f"    {table_name} [{branch_name}]: FAILED")

    # --- Non-Sponte fetchers: run once, not branch-specific ---
    shared_pipeline = [
        # (table_name,         fetch_fn,                 client)
        ("leads",              leads.fetch,               rd),
        ("goals",              goals.fetch,               sheets),
        ("todos",              todos.fetch,               sheets),
        ("teacher_attendance", teacher_attendance.fetch,  sheets),
        ("nps",                nps.fetch,                 sheets),
    ]

    log.info("=== Shared sources (RD Station + Sheets) ===")
    for table_name, fetch_fn, client in shared_pipeline:
        log.info(f"  Starting {table_name}...")
        try:
            ensure_table(table_name)
            rows = fetch_fn(client)
            upsert_rows(table_name, rows)
            log.info(f"    {table_name}: {len(rows)} rows written")
        except Exception:
            log.exception(f"    {table_name}: FAILED")

    log.info("Pipeline complete.")


if __name__ == "__main__":
    run()
