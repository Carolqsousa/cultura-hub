"""
pipeline/sponte/cancellations_xls.py
=====================================
Watches a Google Drive folder for Sponte "Matrículas e Rematrículas" XLS files
and loads them into BigQuery `cancellations_xls` table.

FLOW:
  1. List all .xls files in the configured Drive folder
  2. Check which ones have already been loaded (via processed_files tracker)
  3. For each new file: download → parse → load to BigQuery → mark as processed
  4. If no new files: exit cleanly (idempotent — safe to run every day)

WEEKLY CADENCE:
  You drop 4 XLS files (one per branch) into the Drive folder each week.
  The pipeline runs daily but only processes files it hasn't seen before.
  Reprocessing is blocked by the processed_files.json tracker in Drive.

⚠️  RISK: If you upload a corrected version of a file with the same name,
    it won't be reprocessed. Add a date suffix to the filename to force it:
    e.g.  BV_cancelamentos_2026-06-09.xls

BRANCH DETECTION:
  Branch name is read from inside the XLS (row 0, col 8: "Cultura Inglesa BV").
  You don't need to name files in any specific way — the branch is auto-detected.
  Manual override: set BRANCH_OVERRIDE env var (useful for testing).

Usage:
  python3 cancellations_xls.py

GitHub Actions: see .github/workflows/pipeline_cancellations_xls.yml
"""

import os
import io
import json
import tempfile
import time
from datetime import datetime, timezone

# Google Drive + BigQuery
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from google.cloud import bigquery

# Local parser (same file we built and validated)
import sys
sys.path.insert(0, os.path.dirname(__file__))
from parse_sponte_xls import parse_xls

# ─── Config ───────────────────────────────────────────────────────────────────

# Google Drive folder ID where you drop the XLS files each week.
# Get this from the folder URL: drive.google.com/drive/folders/<FOLDER_ID>
DRIVE_FOLDER_ID = os.environ["DRIVE_CANCELLATIONS_FOLDER_ID"]

# BigQuery
GCP_PROJECT     = os.environ.get("GCP_PROJECT_ID", "cultura-hub")
BQ_DATASET      = "cultura_hub"
BQ_TABLE        = "cancellations_xls"

# Optional: force a branch name (overrides auto-detection from XLS)
BRANCH_OVERRIDE  = os.environ.get("BRANCH_OVERRIDE", "")

# Google credentials — same JSON used by all other pipelines
GCP_CREDS_JSON   = os.environ["GCP_CREDENTIALS_JSON"]


# ─── Google clients ───────────────────────────────────────────────────────────

def build_google_clients():
    scopes = [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/bigquery",
    ]
    creds_dict = json.loads(GCP_CREDS_JSON)
    creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
    drive = build("drive", "v3", credentials=creds)
    bq    = bigquery.Client(project=GCP_PROJECT, credentials=creds)
    return drive, bq


# ─── Drive helpers ────────────────────────────────────────────────────────────

def list_xls_files(drive, folder_id):
    """Return list of {id, name, modifiedTime} for .xls or Google Sheets files in folder."""
    query = (
        f"'{folder_id}' in parents "
        f"and trashed = false "
        f"and ("
        f"name contains '.xls' "
        f"or mimeType = 'application/vnd.google-apps.spreadsheet'"
        f")"
    )
    resp = drive.files().list(
        q=query,
        fields="files(id, name, mimeType, modifiedTime)",
        orderBy="modifiedTime desc"
    ).execute()
    return resp.get("files", [])


def download_file(drive, file_id, mime_type=""):
    """Download a Drive file → bytes in memory.
    Google Sheets files are exported as xlsx; regular files are downloaded directly.
    """
    if mime_type == "application/vnd.google-apps.spreadsheet":
        # Export Google Sheets → xlsx (xlrd can read xlsx too)
        request = drive.files().export_media(
            fileId=file_id,
            mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    else:
        request = drive.files().get_media(fileId=file_id)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    buffer.seek(0)
    return buffer.read(), mime_type


def load_tracker(bq):
    """Load processed file IDs from BigQuery tracker table."""
    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls_tracker"
    try:
        bq.get_table(table_ref)
    except Exception:
        # Create tracker table if it doesn't exist
        schema = [
            bigquery.SchemaField("file_id",    "STRING"),
            bigquery.SchemaField("filename",   "STRING"),
            bigquery.SchemaField("processed",  "TIMESTAMP"),
            bigquery.SchemaField("records",    "INTEGER"),
            bigquery.SchemaField("branch",     "STRING"),
            bigquery.SchemaField("semester",   "STRING"),
            bigquery.SchemaField("status",     "STRING"),
        ]
        bq.create_table(bigquery.Table(table_ref, schema=schema))

    rows = bq.query(f"SELECT file_id, filename, status FROM `{table_ref}`").result()
    return {row.file_id: {"filename": row.filename, "status": row.status} for row in rows}


def save_tracker(bq, file_id, filename, records, branch, semester, status):
    """Save a single processed file record to BigQuery tracker."""
    from datetime import datetime, timezone
    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls_tracker"
    rows = [{
        "file_id":   file_id,
        "filename":  filename,
        "processed": datetime.now(timezone.utc).isoformat(),
        "records":   records,
        "branch":    branch or "",
        "semester":  semester or "",
        "status":    status,
    }]
    errors = bq.insert_rows_json(table_ref, rows)
    if errors:
        raise RuntimeError(f"Tracker insert errors: {errors}")


# ─── BigQuery helpers ─────────────────────────────────────────────────────────

# Schema mirrors the parsed record fields from parse_sponte_xls.py
BQ_SCHEMA = [
    bigquery.SchemaField("loaded_at",           "TIMESTAMP"),
    bigquery.SchemaField("source_filename",      "STRING"),
    bigquery.SchemaField("branch",               "STRING"),
    bigquery.SchemaField("semester",             "STRING"),
    bigquery.SchemaField("event_date",           "DATE"),
    bigquery.SchemaField("tipo",                 "STRING"),   # Rescisão / Trancamento / etc.
    bigquery.SchemaField("student_name",         "STRING"),
    bigquery.SchemaField("contract_id",          "INTEGER"),
    bigquery.SchemaField("parcel",               "INTEGER"),
    bigquery.SchemaField("modality",             "STRING"),
    bigquery.SchemaField("class_name",           "STRING"),
    bigquery.SchemaField("teacher",              "STRING"),
    bigquery.SchemaField("stage_full",           "STRING"),
    bigquery.SchemaField("stage",                "STRING"),
    bigquery.SchemaField("reason",               "STRING"),
    bigquery.SchemaField("attendant",            "STRING"),
    bigquery.SchemaField("is_turma_nao_formou",  "BOOLEAN"),
    bigquery.SchemaField("is_real_churn",        "BOOLEAN"),
]


def ensure_table_exists(bq):
    """Create the BigQuery table if it doesn't exist yet."""
    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"
    try:
        bq.get_table(table_ref)
        print(f"  ✅ Table {BQ_TABLE} exists")
    except Exception:
        table = bigquery.Table(table_ref, schema=BQ_SCHEMA)
        # Partition by event_date for efficient date-range queries
        table.time_partitioning = bigquery.TimePartitioning(
            type_=bigquery.TimePartitioningType.DAY,
            field="event_date"
        )
        bq.create_table(table)
        print(f"  ✅ Created table {BQ_TABLE}")


def delete_existing_records(bq, branch, semester):
    """
    Delete all records for this branch+semester before inserting fresh ones.
    This makes the load idempotent — uploading the same file twice is safe.

    ⚠️  RISK: This deletes ALL records for the branch+semester, not just the
    ones from this file. That's intentional — each weekly upload is the
    authoritative full picture for that branch's semester.
    """
    query = f"""
        DELETE FROM `{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}`
        WHERE branch = @branch
          AND semester = @semester
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("branch",   "STRING", branch),
            bigquery.ScalarQueryParameter("semester", "STRING", semester),
        ]
    )
    bq.query(query, job_config=job_config).result()
    print(f"  🗑️  Cleared existing records for {branch} / {semester}")


def insert_records(bq, records, source_filename):
    """Insert parsed records into BigQuery."""
    if not records:
        print("  ⚠️  No records to insert")
        return 0

    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for r in records:
        rows.append({
            "loaded_at":          now,
            "source_filename":    source_filename,
            "branch":             r["branch"],
            "semester":           r["semester"] or "",
            "event_date":         r["event_date"],
            "tipo":               r["tipo"],
            "student_name":       r["student_name"],
            "contract_id":        r["contract_id"],
            "parcel":             r["parcel"],
            "modality":           r["modality"],
            "class_name":         r["class_name"] or "",
            "teacher":            r["teacher"] or "",
            "stage_full":         r["stage_full"] or "",
            "stage":              r["stage"] or "",
            "reason":             r["reason"],
            "attendant":          r["attendant"],
            "is_turma_nao_formou": r["is_turma_nao_formou"],
            "is_real_churn":      r["is_real_churn"],
        })

    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"
    errors = bq.insert_rows_json(table_ref, rows)
    if errors:
        raise RuntimeError(f"BigQuery insert errors: {errors}")

    print(f"  ✅ Inserted {len(rows)} records into {BQ_TABLE}")
    return len(rows)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print(f"  Cancellations XLS → BigQuery")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    drive, bq = build_google_clients()
    ensure_table_exists(bq)

    # Load tracker
    tracker = load_tracker(bq)
    print(f"\n📋 Previously processed files: {len(tracker)}")

    # List XLS files in Drive folder
    xls_files = [f for f in list_xls_files(drive, DRIVE_FOLDER_ID)
                 if f["name"] != "processed_files.json"]
    print(f"📁 XLS files in Drive folder: {len(xls_files)}")

    new_files   = [f for f in xls_files if f["id"] not in tracker]
    skip_files  = [f for f in xls_files if f["id"] in tracker]

    print(f"  → New (to process): {len(new_files)}")
    print(f"  → Already done:     {len(skip_files)}")

    if not new_files:
        print("\n✅ Nothing new to process. Exiting.")
        return

    total_records = 0

    for file_info in new_files:
        file_id   = file_info["id"]
        file_name = file_info["name"]
        print(f"\n📄 Processing: {file_name}")

        try:
            # Download to temp file (parse_xls needs a path, not bytes)
            file_mime  = file_info.get("mimeType", "")
            raw_bytes, file_mime = download_file(drive, file_id, file_mime)
            # Google Sheets exports as xlsx; plain uploads keep .xls
            suffix = ".xlsx" if file_mime == "application/vnd.google-apps.spreadsheet" else ".xls"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(raw_bytes)
                tmp_path = tmp.name

            # Parse (pass suffix so parser picks correct engine)
            records = parse_xls(tmp_path, branch_override=BRANCH_OVERRIDE or None,
                                force_engine="openpyxl" if suffix == ".xlsx" else None)
            os.unlink(tmp_path)

            if not records:
                print(f"  ⚠️  No records parsed from {file_name} — skipping")
                tracker[file_id] = {
                    "filename":   file_name,
                    "processed":  datetime.now(timezone.utc).isoformat(),
                    "records":    0,
                    "status":     "empty",
                }
                continue

            branch   = records[0]["branch"]
            semester = records[0]["semester"]
            print(f"  Branch: {branch} | Semester: {semester} | Records: {len(records)}")

            # Delete existing + insert fresh
            delete_existing_records(bq, branch, semester)
            n = insert_records(bq, records, file_name)
            total_records += n

            # Mark as processed
            save_tracker(bq, file_id, file_name, n, branch, semester, "ok")
            tracker[file_id] = {"filename": file_name, "status": "ok"}

        except Exception as e:
            print(f"  ❌ Error processing {file_name}: {e}")
            save_tracker(bq, file_id, file_name, 0, "", "", f"error: {str(e)[:200]}")
            tracker[file_id] = {"filename": file_name, "status": "error"}
            # Don't re-raise — continue with other files

        time.sleep(0.5)

    print(f"\n✅ Done. Total records loaded: {total_records}")


if __name__ == "__main__":
    main()
