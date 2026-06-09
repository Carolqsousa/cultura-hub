"""
pipeline/sponte/cancellations_xls.py
=====================================
Watches a Google Drive folder for Sponte "Matrículas e Rematrículas" XLS files
and loads them into BigQuery `cancellations_xls` table.

FLOW:
  1. List all XLS / Google Sheets files in the configured Drive folder
  2. Check which ones have already been loaded (via BigQuery tracker table)
  3. For each new file: download → parse → MERGE into BigQuery → mark as processed
  4. If no new files: exit cleanly (safe to run every day)

WEEKLY CADENCE:
  Drop 4 XLS files (one per branch) into the Drive folder each week.
  The pipeline runs daily but only processes files it hasn't seen before.

REPROCESSING:
  Rename the file (e.g. add _v2) so it gets a new Drive ID.
  The tracker uses Drive file ID, not filename.
"""

import os
import io
import json
import tempfile
import time
from datetime import datetime, timezone

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from google.cloud import bigquery

import sys
sys.path.insert(0, os.path.dirname(__file__))
from parse_sponte_xls import parse_xls

# ─── Config ───────────────────────────────────────────────────────────────────

DRIVE_FOLDER_ID = os.environ["DRIVE_CANCELLATIONS_FOLDER_ID"]
GCP_PROJECT     = os.environ.get("GCP_PROJECT_ID", "cultura-hub")
BQ_DATASET      = "cultura_hub"
BQ_TABLE        = "cancellations_xls"
BRANCH_OVERRIDE = os.environ.get("BRANCH_OVERRIDE", "")
GCP_CREDS_JSON  = os.environ["GCP_CREDENTIALS_JSON"]

# ─── BigQuery schema ──────────────────────────────────────────────────────────

BQ_SCHEMA = [
    bigquery.SchemaField("loaded_at",           "TIMESTAMP"),
    bigquery.SchemaField("source_filename",      "STRING"),
    bigquery.SchemaField("branch",               "STRING"),
    bigquery.SchemaField("semester",             "STRING"),
    bigquery.SchemaField("event_date",           "DATE"),
    bigquery.SchemaField("tipo",                 "STRING"),
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

# ─── Google clients ───────────────────────────────────────────────────────────

def build_clients():
    scopes = [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/bigquery",
    ]
    creds = Credentials.from_service_account_info(
        json.loads(GCP_CREDS_JSON), scopes=scopes
    )
    drive = build("drive", "v3", credentials=creds)
    bq    = bigquery.Client(project=GCP_PROJECT, credentials=creds)
    return drive, bq


# ─── Drive helpers ────────────────────────────────────────────────────────────

def list_files(drive, folder_id):
    """List XLS and Google Sheets files in the Drive folder."""
    query = (
        f"'{folder_id}' in parents "
        f"and trashed = false "
        f"and ("
        f"  name contains '.xls' "
        f"  or mimeType = 'application/vnd.google-apps.spreadsheet'"
        f")"
    )
    resp = drive.files().list(
        q=query,
        fields="files(id, name, mimeType, modifiedTime)",
        orderBy="modifiedTime desc"
    ).execute()
    return resp.get("files", [])


def download_file(drive, file_id, mime_type=""):
    """Download file bytes. Google Sheets are exported as xlsx."""
    if mime_type == "application/vnd.google-apps.spreadsheet":
        request = drive.files().export_media(
            fileId=file_id,
            mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        ext = ".xlsx"
    else:
        request = drive.files().get_media(fileId=file_id)
        ext = ".xls"

    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    buffer.seek(0)
    return buffer.read(), ext


# ─── BigQuery tracker ─────────────────────────────────────────────────────────

TRACKER_TABLE = f"cancellations_xls_tracker"

def ensure_tracker(bq):
    """Create tracker table if it doesn't exist."""
    ref = f"{GCP_PROJECT}.{BQ_DATASET}.{TRACKER_TABLE}"
    try:
        bq.get_table(ref)
    except Exception:
        schema = [
            bigquery.SchemaField("file_id",   "STRING"),
            bigquery.SchemaField("filename",  "STRING"),
            bigquery.SchemaField("processed", "TIMESTAMP"),
            bigquery.SchemaField("records",   "INTEGER"),
            bigquery.SchemaField("branch",    "STRING"),
            bigquery.SchemaField("semester",  "STRING"),
            bigquery.SchemaField("status",    "STRING"),
        ]
        bq.create_table(bigquery.Table(ref, schema=schema))
        print(f"  ✅ Created tracker table")


def load_tracker(bq):
    """Return set of already-processed file IDs."""
    ref = f"{GCP_PROJECT}.{BQ_DATASET}.{TRACKER_TABLE}"
    rows = bq.query(f"SELECT file_id FROM `{ref}`").result()
    return {row.file_id for row in rows}


def save_tracker(bq, file_id, filename, records, branch, semester, status):
    """Record a processed file in the tracker."""
    ref = f"{GCP_PROJECT}.{BQ_DATASET}.{TRACKER_TABLE}"
    rows = [{
        "file_id":   file_id,
        "filename":  filename,
        "processed": datetime.now(timezone.utc).isoformat(),
        "records":   records,
        "branch":    branch or "",
        "semester":  semester or "",
        "status":    status,
    }]
    job = bq.load_table_from_json(
        rows, ref,
        job_config=bigquery.LoadJobConfig(
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND
        )
    )
    job.result()


# ─── BigQuery main table ──────────────────────────────────────────────────────

def ensure_main_table(bq):
    """Create cancellations_xls table if it doesn't exist."""
    ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"
    try:
        bq.get_table(ref)
        print(f"  ✅ Table {BQ_TABLE} exists")
    except Exception:
        table = bigquery.Table(ref, schema=BQ_SCHEMA)
        bq.create_table(table)
        print(f"  ✅ Created table {BQ_TABLE}")


def upsert_records(bq, records, source_filename, branch, semester):
    """
    Load records using a MERGE statement — atomically replaces all records
    for this branch+semester. Safe to run multiple times (idempotent).
    No streaming buffer conflicts.
    """
    if not records:
        print("  ⚠️  No records to insert")
        return 0

    now = datetime.now(timezone.utc).isoformat()
    rows = [{
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
    } for r in records]

    # Step 1: load into temp table (WRITE_TRUNCATE — always clean)
    temp_ref = f"{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls_temp"
    job = bq.load_table_from_json(
        rows, temp_ref,
        job_config=bigquery.LoadJobConfig(
            schema=BQ_SCHEMA,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        )
    )
    job.result()
    if job.errors:
        raise RuntimeError(f"Temp load errors: {job.errors}")

    # Step 2: MERGE temp into main — replaces branch+semester, keeps others
    main_ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"
    merge_sql = f"""
        MERGE `{main_ref}` T
        USING `{temp_ref}` S
          ON  T.branch       = S.branch
          AND T.semester     = S.semester
          AND T.student_name = S.student_name
          AND T.event_date   = S.event_date
        WHEN MATCHED THEN
          UPDATE SET
            loaded_at = S.loaded_at, source_filename = S.source_filename,
            tipo = S.tipo, contract_id = S.contract_id, parcel = S.parcel,
            modality = S.modality, class_name = S.class_name,
            teacher = S.teacher, stage_full = S.stage_full, stage = S.stage,
            reason = S.reason, attendant = S.attendant,
            is_turma_nao_formou = S.is_turma_nao_formou,
            is_real_churn = S.is_real_churn
        WHEN NOT MATCHED BY TARGET THEN
          INSERT ROW
        WHEN NOT MATCHED BY SOURCE
          AND T.branch = @branch AND T.semester = @semester THEN
          DELETE
    """
    bq.query(
        merge_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("branch",   "STRING", branch),
            bigquery.ScalarQueryParameter("semester", "STRING", semester),
        ])
    ).result()

    # Step 3: clean up temp table
    bq.delete_table(temp_ref, not_found_ok=True)

    print(f"  ✅ Merged {len(rows)} records → {BQ_TABLE} (branch={branch}, semester={semester})")
    return len(rows)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print(f"  Cancellations XLS → BigQuery")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 60)

    drive, bq = build_clients()

    ensure_main_table(bq)
    ensure_tracker(bq)

    processed = load_tracker(bq)
    print(f"\n📋 Previously processed files: {len(processed)}")

    all_files = list_files(drive, DRIVE_FOLDER_ID)
    print(f"📁 Files in Drive folder: {len(all_files)}")

    new_files  = [f for f in all_files if f["id"] not in processed]
    done_files = [f for f in all_files if f["id"] in processed]

    print(f"  → New (to process): {len(new_files)}")
    print(f"  → Already done:     {len(done_files)}")

    if not new_files:
        print("\n✅ Nothing new to process. Exiting.")
        return

    total = 0

    for file_info in new_files:
        file_id   = file_info["id"]
        file_name = file_info["name"]
        mime_type = file_info.get("mimeType", "")
        print(f"\n📄 Processing: {file_name}")

        try:
            raw_bytes, ext = download_file(drive, file_id, mime_type)

            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                tmp.write(raw_bytes)
                tmp_path = tmp.name

            engine  = "openpyxl" if ext == ".xlsx" else None
            records = parse_xls(
                tmp_path,
                branch_override=BRANCH_OVERRIDE or None,
                force_engine=engine
            )
            os.unlink(tmp_path)

            if not records:
                print(f"  ⚠️  No records parsed — skipping")
                save_tracker(bq, file_id, file_name, 0, "", "", "empty")
                continue

            branch   = records[0]["branch"]
            semester = records[0]["semester"]
            print(f"  Branch: {branch} | Semester: {semester} | Records: {len(records)}")

            n = upsert_records(bq, records, file_name, branch, semester)
            total += n

            save_tracker(bq, file_id, file_name, n, branch, semester, "ok")

        except Exception as e:
            print(f"  ❌ Error: {e}")
            save_tracker(bq, file_id, file_name, 0, "", "", f"error: {str(e)[:200]}")

        time.sleep(0.5)

    print(f"\n✅ Done. Total records loaded: {total}")


if __name__ == "__main__":
    main()
