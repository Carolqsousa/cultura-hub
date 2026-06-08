"""
pipeline/run_cancellations.py
==============================
Runner for the cancellations pipeline.
Detects cancellations from student snapshots and writes to BigQuery.
"""

import os
import sys
from google.cloud import bigquery

# Allow running from repo root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pipeline.sponte.cancellations import CancellationDetector

PROJECT = os.environ.get("GCP_PROJECT_ID", "cultura-hub")
DATASET = "cultura_hub"
TABLE   = f"{PROJECT}.{DATASET}.cancellations"


def ensure_table(client: bigquery.Client):
    schema = [
        bigquery.SchemaField("cancellation_date", "DATE"),
        bigquery.SchemaField("branch",             "STRING"),
        bigquery.SchemaField("student_id",         "STRING"),
        bigquery.SchemaField("student_name",       "STRING"),
        bigquery.SchemaField("class_id",           "STRING"),
        bigquery.SchemaField("class_name",         "STRING"),
        bigquery.SchemaField("teacher",            "STRING"),
        bigquery.SchemaField("stage",              "STRING"),
        bigquery.SchemaField("last_seen_date",     "DATE"),
        bigquery.SchemaField("run_date",           "DATE"),
    ]
    table = bigquery.Table(TABLE, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="run_date")
    client.create_table(table, exists_ok=True)
    print(f"  [cancellations] Table ready: {TABLE}")


def main():
    client    = bigquery.Client(project=PROJECT)
    detector  = CancellationDetector(PROJECT)

    ensure_table(client)

    rows = detector.detect()
    if not rows:
        print("[cancellations] Nothing to insert.")
        return

    # Avoid duplicate insertions for today
    today = rows[0]["run_date"]
    try:
        client.query(f"""
            DELETE FROM `{TABLE}`
            WHERE run_date = DATE '{today}'
        """).result()
        print(f"  [cancellations] Cleared existing rows for {today}")
    except Exception as e:
        print(f"  [cancellations] Skipping delete (table may be empty): {e}")

    print(f"  [cancellations] Sample row: {rows[0]}")
    errors = client.insert_rows_json(TABLE, rows)
    if errors:
        print(f"  [cancellations] ❌ Errors: {errors}")
        sys.exit(1)
    else:
        print(f"  [cancellations] ✅ Inserted {len(rows)} cancellations for {today}")


if __name__ == "__main__":
    main()
