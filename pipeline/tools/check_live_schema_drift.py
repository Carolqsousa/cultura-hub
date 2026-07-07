#!/usr/bin/env python3
"""
pipeline/tools/check_live_schema_drift.py
============================================
Catches a different, more dangerous class of drift than
check_schema_drift.py: the repo's schema JSON file silently disagreeing
with what's ACTUALLY in the live BigQuery table.

WHY THIS IS A SEPARATE CHECK:
  check_schema_drift.py compares:  fetcher code  <->  schema JSON file
  This script compares:            schema JSON file  <->  live BigQuery table

  A file can claim anything — someone can run a manual ALTER TABLE (or a
  load job with auto schema-update) directly against BigQuery without ever
  touching the repo. The file then quietly lies about reality. This is
  exactly what happened to `students`: the live table already had
  registered_class_ids, but the checked-in students.json didn't know that,
  and the pipeline built its LoadJobConfig FROM the file — enforcing a
  schema that was already stale, rejecting rows that would have fit the
  real table fine.

WHY THIS RUNS ON PUSH TO MAIN ONLY, NOT ON PULL REQUESTS:
  This script needs real GCP credentials to query BigQuery. PR workflows
  (especially from forks) should never have access to production secrets —
  a malicious PR could otherwise exfiltrate credentials via a crafted
  workflow file. check_schema_drift.py (the static, no-credentials check)
  is safe on every PR; this one is deliberately restricted to main.

HOW TO RUN LOCALLY (needs GCP_CREDENTIALS_JSON env var set):
  python pipeline/tools/check_live_schema_drift.py

EXIT CODE:
  0 = repo files match live tables, 1 = drift found (details printed).
"""

import json
import os
import sys
from pathlib import Path

from google.cloud import bigquery
from google.oauth2.service_account import Credentials

REPO_ROOT   = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = REPO_ROOT / "pipeline" / "bigquery" / "schemas"

PROJECT_ID = os.environ.get("GCP_PROJECT_ID", "cultura-hub")
DATASET    = os.environ.get("BQ_DATASET", "cultura_hub")


def get_client() -> bigquery.Client:
    creds_json = os.environ.get("GCP_CREDENTIALS_JSON")
    if creds_json:
        creds = Credentials.from_service_account_info(
            json.loads(creds_json),
            scopes=["https://www.googleapis.com/auth/bigquery"],
        )
        return bigquery.Client(project=PROJECT_ID, credentials=creds)
    return bigquery.Client(project=PROJECT_ID)


def load_file_schema(schema_file: Path) -> dict[str, dict]:
    """Returns {field_name: {"type": ..., "mode": ...}} from the repo JSON file."""
    fields = json.loads(schema_file.read_text())
    return {f["name"]: {"type": f["type"], "mode": f.get("mode", "NULLABLE")} for f in fields}


def get_live_schema(client: bigquery.Client, table_name: str) -> dict[str, dict] | None:
    """Returns the same shape from the actual live BigQuery table, or None if it doesn't exist."""
    table_ref = f"{PROJECT_ID}.{DATASET}.{table_name}"
    try:
        table = client.get_table(table_ref)
    except Exception:
        return None
    return {
        f.name: {"type": f.field_type, "mode": f.mode}
        for f in table.schema
    }


def compare(table_name: str, file_schema: dict, live_schema: dict) -> list[str]:
    problems = []

    file_fields = set(file_schema)
    live_fields = set(live_schema)

    # Fields the live table has that the repo file doesn't know about —
    # this is exactly the students.py bug: someone altered the real table
    # and the repo file was never updated to match.
    only_in_live = live_fields - file_fields
    if only_in_live:
        problems.append(
            f"[{table_name}] live table has field(s) {sorted(only_in_live)} that "
            f"the repo's schema JSON doesn't declare — the file is stale. If a "
            f"pipeline builds its LoadJobConfig schema from this file, it will "
            f"wrongly reject rows that actually fit the real table."
        )

    # Fields the repo file claims exist that the live table doesn't have —
    # the opposite drift: documentation describing a table that doesn't
    # exist yet, or a column that was removed from BigQuery without
    # updating the file.
    only_in_file = file_fields - live_fields
    if only_in_file:
        problems.append(
            f"[{table_name}] repo schema JSON declares field(s) {sorted(only_in_file)} "
            f"that the live table doesn't have — either the migration was never run, "
            f"or the column was dropped from BigQuery without updating the file."
        )

    # Type/mode mismatches on fields both sides agree exist.
    for name in file_fields & live_fields:
        f_type, f_mode = file_schema[name]["type"], file_schema[name]["mode"]
        l_type, l_mode = live_schema[name]["type"], live_schema[name]["mode"]
        # BigQuery normalizes some type aliases (e.g. FLOAT64 vs FLOAT) —
        # compare loosely to avoid false positives on equivalent types.
        norm = lambda t: t.upper().replace("FLOAT64", "FLOAT").replace("INT64", "INTEGER")
        if norm(f_type) != norm(l_type):
            problems.append(
                f"[{table_name}] field '{name}': repo file says type {f_type}, "
                f"live table says {l_type}"
            )
        if f_mode != l_mode:
            problems.append(
                f"[{table_name}] field '{name}': repo file says mode {f_mode}, "
                f"live table says {l_mode}"
            )

    return problems


def main() -> int:
    if not SCHEMAS_DIR.exists():
        print(f"⚠️  {SCHEMAS_DIR} not found — nothing to check.")
        return 0

    client = get_client()
    all_problems: list[str] = []
    checked = 0
    skipped_no_table = []

    for schema_file in sorted(SCHEMAS_DIR.glob("*.json")):
        table_name = schema_file.stem
        file_schema = load_file_schema(schema_file)
        live_schema = get_live_schema(client, table_name)

        if live_schema is None:
            # Table doesn't exist yet — not drift, just "not deployed yet".
            # Pipelines that auto-create tables from this file will handle
            # it on first run, so this isn't a failure, just informational.
            skipped_no_table.append(table_name)
            continue

        checked += 1
        all_problems.extend(compare(table_name, file_schema, live_schema))

    print(f"Checked {checked} table(s) against live BigQuery in {PROJECT_ID}.{DATASET}\n")
    if skipped_no_table:
        print(f"ℹ️  Skipped (table not created yet): {', '.join(skipped_no_table)}\n")

    if all_problems:
        print("❌ Live schema drift detected:\n")
        for p in all_problems:
            print(f"  - {p}")
        print(
            "\nFix: decide which side is correct (the file or the live table), "
            "then either run an ALTER TABLE to match the file, or update the "
            "file to match the live table — and commit the file change so "
            "the repo stops lying about reality."
        )
        return 1

    print("✅ No live drift — every repo schema file matches its real BigQuery table.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
