"""Daily pipeline entry point — runs all sources and writes to BigQuery."""

import logging

from bigquery.client import ensure_table, upsert_rows

# Sponte modules
from sponte import students, financials, attendance, grades, cancellations
from sponte.diary_checks import fetch as fetch_diary

# RD Station modules
from rd_station import leads

# Google Sheets modules
from google_sheets import goals, todos, teacher_attendance, nps

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def run():
    # Import clients here so credentials are only loaded at runtime
    from sponte_client import SponteClient          # your existing script
    from rd_station_client import RDStationClient   # TODO: implement
    from sheets_client import GoogleSheetsClient    # TODO: implement
    from sponte.diary_checks import fetch as fetch_diary

    sponte = SponteClient()
    rd = RDStationClient()
    sheets = GoogleSheetsClient()

    pipeline = [
        # (table_name,         fetch_fn,                    client)
        ("students",           students.fetch,              sponte),
        ("financials",         financials.fetch,            sponte),
        ("attendance",         attendance.fetch,            sponte),
        ("grades",             grades.fetch,                sponte),
        ("cancellations",      cancellations.fetch,         sponte),
        ("leads",              leads.fetch,                 rd),
        ("goals",              goals.fetch,                 sheets),
        ("todos",              todos.fetch,                 sheets),
        ("teacher_attendance", teacher_attendance.fetch,    sheets),
        ("nps",                nps.fetch,                   sheets),
        ("diary_checks",       fetch_diary,                 sponte),
    ]

    for table_name, fetch_fn, client in pipeline:
        log.info(f"Starting {table_name}...")
        try:
            ensure_table(table_name)
            rows = fetch_fn(client)
            upsert_rows(table_name, rows)
            log.info(f"  {table_name}: {len(rows)} rows written")
        except Exception:
            log.exception(f"  {table_name}: FAILED")

    log.info("Pipeline complete.")


if __name__ == "__main__":
    run()
