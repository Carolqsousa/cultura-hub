"""
pipeline/sponte/renewal_tracker.py
====================================
Tracks student renewal status across semester transitions, with special
care for the two critical milestone dates: Jun 29 and Dec 30.

TWO SEPARATE OPERATIONS, RUN EVERY DAY:

  1. CAPTURE BASELINE (one-time, on the exact milestone date)
     On Jun 29 and Dec 30 specifically, freezes a permanent snapshot of
     every active student into `renewal_baseline` table. This NEVER gets
     recalculated or overwritten — it's the historical record of "who was
     here on this date." Critical because annual-payers (year-end) and
     some semester-payers (mid-year) may disappear from the students
     table entirely shortly after, so this is the last reliable capture.

  2. CHECK STATUS (every day, using the frozen baseline)
     Compares the frozen baseline against the latest available students
     snapshot to classify each student as:
       Renovado  - registered_class_ids includes a next-semester class
       Cancelado - no longer appears in students table at all
       Pendente  - still active, no next-semester registration yet
     This check re-runs daily for 90 days after each milestone, so late
     renewals (especially around Dec 30 -> Jan, when families travel) are
     still caught.

WHY DEC 30 GETS EXTRA CARE:
  Annual payers can vanish quickly after Dec 30 if they don't renew.
  The baseline capture for Dec 30 is treated with extra logging/warnings
  since missing it means losing the entire list of year-end students
  with no way to reconstruct it later.

GENERIC ACROSS YEARS:
  Semester dates are computed relative to today's actual date - no
  hardcoded years. Works for 2026->2027, 2027->2028, forever, as long as
  the school calendar rule (Feb 1/Jun 29, Aug 1/Dec 30) doesn't change.

Usage:
  python3 pipeline/sponte/renewal_tracker.py
"""

import os
import json
import time
import requests
from datetime import date, datetime, timezone
from google.oauth2.service_account import Credentials
from google.cloud import bigquery

# --- Config -------------------------------------------------------------------

GCP_PROJECT      = os.environ.get("GCP_PROJECT_ID", "cultura-hub")
BQ_DATASET       = "cultura_hub"
BASELINE_TABLE   = "renewal_baseline"
STATUS_TABLE     = "renewal_status"
GCP_CREDS_JSON   = os.environ["GCP_CREDENTIALS_JSON"]

BASE_URL = "https://webservices.sponteweb.com.br/WSApiSponteRest/api"

BRANCHES = {
    "Boa Viagem": os.environ.get("SPONTE_API_KEY_BOA_VIAGEM"),
    "Young":      os.environ.get("SPONTE_API_KEY_YOUNG"),
    "Setubal":    os.environ.get("SPONTE_API_KEY_SETUBAL"),
    "Natal":      os.environ.get("SPONTE_API_KEY_NATAL"),
}

# How many days after the milestone we keep checking for renewals
STATUS_CHECK_WINDOW_DAYS = 90


# --- Semester calendar ----------------------------------------------------------
# Edit here if the school calendar ever changes.

def semester_end_date(semester: str) -> date:
    year, half = semester.split(".")
    year = int(year)
    return date(year, 6, 29) if half == "1" else date(year, 12, 30)


def next_semester(semester: str) -> str:
    year, half = semester.split(".")
    year = int(year)
    return f"{year}.2" if half == "1" else f"{year + 1}.1"


def get_all_milestones(today: date) -> list:
    """Returns semester codes whose end_date is within reach of today
    (checked against a wide range to be safe - cheap to compute)."""
    candidates = []
    for year in (today.year - 1, today.year, today.year + 1):
        candidates.append(f"{year}.1")
        candidates.append(f"{year}.2")
    return candidates


# --- BigQuery -------------------------------------------------------------------

def get_bq():
    creds = Credentials.from_service_account_info(
        json.loads(GCP_CREDS_JSON),
        scopes=["https://www.googleapis.com/auth/bigquery"],
    )
    return bigquery.Client(project=GCP_PROJECT, credentials=creds)


def bq_query(bq, sql):
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(
        default_dataset=f"{GCP_PROJECT}.{BQ_DATASET}"
    )).result()
    return [dict(row) for row in rows]


BASELINE_SCHEMA = [
    bigquery.SchemaField("captured_at",      "TIMESTAMP"),
    bigquery.SchemaField("ending_semester",  "STRING"),
    bigquery.SchemaField("next_semester",    "STRING"),
    bigquery.SchemaField("baseline_date",    "DATE"),
    bigquery.SchemaField("student_id",       "STRING"),
    bigquery.SchemaField("name",             "STRING"),
    bigquery.SchemaField("branch",           "STRING"),
    bigquery.SchemaField("registered_class_ids_at_baseline", "STRING"),
]

STATUS_SCHEMA = [
    bigquery.SchemaField("checked_at",        "TIMESTAMP"),
    bigquery.SchemaField("ending_semester",   "STRING"),
    bigquery.SchemaField("next_semester",     "STRING"),
    bigquery.SchemaField("baseline_date",     "DATE"),
    bigquery.SchemaField("latest_check_date", "DATE"),
    bigquery.SchemaField("student_id",        "STRING"),
    bigquery.SchemaField("name",              "STRING"),
    bigquery.SchemaField("branch",            "STRING"),
    bigquery.SchemaField("status",            "STRING"),
    bigquery.SchemaField("next_class_id",     "STRING"),
]


def ensure_tables(bq):
    for table, schema in [(BASELINE_TABLE, BASELINE_SCHEMA), (STATUS_TABLE, STATUS_SCHEMA)]:
        ref = f"{GCP_PROJECT}.{BQ_DATASET}.{table}"
        try:
            bq.get_table(ref)
            print(f"  OK table {table} exists")
        except Exception:
            bq.create_table(bigquery.Table(ref, schema=schema))
            print(f"  Created table {table}")


def baseline_already_captured(bq, ending_sem):
    rows = bq_query(bq, f"""
        SELECT COUNT(*) AS n
        FROM `{GCP_PROJECT}.{BQ_DATASET}.{BASELINE_TABLE}`
        WHERE ending_semester = '{ending_sem}'
    """)
    return rows[0]["n"] > 0 if rows else False


# --- Step 1: Capture baseline (one-time, on exact milestone date) -------------

def capture_baseline(bq, ending_sem, milestone_date):
    if baseline_already_captured(bq, ending_sem):
        print(f"  Baseline for {ending_sem} already captured - skipping")
        return

    print(f"  Capturing baseline for {ending_sem} (milestone: {milestone_date})")

    snap_check = bq_query(bq, f"""
        SELECT MAX(date) AS d
        FROM `{GCP_PROJECT}.{BQ_DATASET}.students`
        WHERE date <= '{milestone_date.isoformat()}'
    """)
    actual_date = snap_check[0]["d"] if snap_check and snap_check[0]["d"] else None
    if not actual_date:
        print(f"  WARNING: No students snapshot available on or before {milestone_date}")
        return

    actual_date_str = (
        actual_date.strftime("%Y-%m-%d") if hasattr(actual_date, "strftime") else str(actual_date)
    )

    if actual_date_str != milestone_date.isoformat():
        print(f"  WARNING: exact milestone snapshot not found, using {actual_date_str} instead")
        print(f"  WARNING: This is a CRITICAL gap for annual-payer tracking - investigate pipeline reliability")

    students = bq_query(bq, f"""
        SELECT student_id, name, branch, registered_class_ids
        FROM `{GCP_PROJECT}.{BQ_DATASET}.students`
        WHERE date = '{actual_date_str}'
    """)

    if not students:
        print(f"  WARNING: No students found in snapshot {actual_date_str} - aborting baseline capture")
        return

    now = datetime.now(timezone.utc).isoformat()
    rows = [{
        "captured_at":     now,
        "ending_semester": ending_sem,
        "next_semester":   next_semester(ending_sem),
        "baseline_date":   actual_date_str,
        "student_id":      s["student_id"],
        "name":            s["name"],
        "branch":          s["branch"],
        "registered_class_ids_at_baseline": s.get("registered_class_ids") or "",
    } for s in students]

    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BASELINE_TABLE}"
    job = bq.load_table_from_json(
        rows, table_ref,
        job_config=bigquery.LoadJobConfig(
            schema=BASELINE_SCHEMA,
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        )
    )
    job.result()
    if job.errors:
        raise RuntimeError(f"Baseline load errors: {job.errors}")

    print(f"  Baseline frozen: {len(rows)} students for {ending_sem} (date={actual_date_str})")


# --- Sponte API - next semester classes ---------------------------------------

def fetch_next_semester_class_ids(branch, api_key, next_sem):
    if not api_key:
        return set()
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "api_key": api_key,
    }
    try:
        r = requests.get(f"{BASE_URL}/classes", headers=headers, timeout=60)
        r.raise_for_status()
        classes = r.json()
    except Exception as e:
        print(f"    WARNING [{branch}] Failed to fetch classes: {e}")
        return set()

    ids = {str(c["class_id"]) for c in classes if next_sem in c.get("name", "")}
    print(f"    [{branch}] {len(ids)} classes found for {next_sem}")
    return ids


# --- Step 2: Check status (every day, using frozen baseline) -----------------

def check_status(bq, ending_sem):
    next_sem = next_semester(ending_sem)

    baseline = bq_query(bq, f"""
        SELECT student_id, name, branch, baseline_date,
               registered_class_ids_at_baseline
        FROM `{GCP_PROJECT}.{BQ_DATASET}.{BASELINE_TABLE}`
        WHERE ending_semester = '{ending_sem}'
    """)
    if not baseline:
        print(f"  No baseline for {ending_sem} yet - nothing to check")
        return []

    baseline_date_str = str(baseline[0]["baseline_date"])
    print(f"  Baseline: {len(baseline)} students (frozen on {baseline_date_str})")

    latest_check = bq_query(bq, f"""
        SELECT MAX(date) AS d FROM `{GCP_PROJECT}.{BQ_DATASET}.students`
    """)
    latest_date = latest_check[0]["d"]
    latest_date_str = (
        latest_date.strftime("%Y-%m-%d") if hasattr(latest_date, "strftime") else str(latest_date)
    )
    print(f"  Latest snapshot: {latest_date_str}")

    print(f"  Fetching {next_sem} classes from Sponte...")
    next_sem_classes_by_branch = {}
    for branch, api_key in BRANCHES.items():
        next_sem_classes_by_branch[branch] = fetch_next_semester_class_ids(branch, api_key, next_sem)
        time.sleep(0.2)

    latest_students = bq_query(bq, f"""
        SELECT student_id, branch, registered_class_ids
        FROM `{GCP_PROJECT}.{BQ_DATASET}.students`
        WHERE date = '{latest_date_str}'
    """)
    latest_map = {(s["student_id"], s["branch"]): s for s in latest_students}

    now = datetime.now(timezone.utc).isoformat()
    rows = []

    for b in baseline:
        key = (b["student_id"], b["branch"])
        latest = latest_map.get(key)
        next_sem_ids = next_sem_classes_by_branch.get(b["branch"], set())

        if latest is None:
            status, next_class_id = "Cancelado", ""
        else:
            reg_ids = set((latest.get("registered_class_ids") or "").split(","))
            reg_ids.discard("")
            matched = reg_ids & next_sem_ids
            if matched:
                status, next_class_id = "Renovado", next(iter(matched))
            else:
                status, next_class_id = "Pendente", ""

        rows.append({
            "checked_at":        now,
            "ending_semester":   ending_sem,
            "next_semester":     next_sem,
            "baseline_date":     baseline_date_str,
            "latest_check_date": latest_date_str,
            "student_id":        b["student_id"],
            "name":              b["name"],
            "branch":            b["branch"],
            "status":            status,
            "next_class_id":     next_class_id,
        })

    return rows


def load_status_rows(bq, rows, ending_sem):
    if not rows:
        return 0
    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.{STATUS_TABLE}"
    bq.query(f"""
        DELETE FROM `{table_ref}` WHERE ending_semester = '{ending_sem}'
    """).result()
    job = bq.load_table_from_json(
        rows, table_ref,
        job_config=bigquery.LoadJobConfig(
            schema=STATUS_SCHEMA,
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        )
    )
    job.result()
    if job.errors:
        raise RuntimeError(f"Status load errors: {job.errors}")
    return len(rows)


# --- Main -----------------------------------------------------------------------

def main():
    today = date.today()
    print("=" * 60)
    print(f"  Renewal Tracker")
    print(f"  Today: {today.isoformat()}")
    print("=" * 60)

    bq = get_bq()
    ensure_tables(bq)

    did_anything = False

    for sem in get_all_milestones(today):
        end = semester_end_date(sem)
        days_since_end = (today - end).days

        if days_since_end == 0:
            print(f"\nMILESTONE DAY for {sem} (end={end})")
            capture_baseline(bq, sem, end)
            did_anything = True

        elif 0 < days_since_end <= 3 and not baseline_already_captured(bq, sem):
            print(f"\nRetry baseline capture for {sem} ({days_since_end} days after milestone)")
            capture_baseline(bq, sem, end)
            did_anything = True

        if 0 <= days_since_end <= STATUS_CHECK_WINDOW_DAYS:
            print(f"\nChecking renewal status: {sem} -> {next_semester(sem)} (day {days_since_end} of {STATUS_CHECK_WINDOW_DAYS})")
            rows = check_status(bq, sem)
            if rows:
                renewed   = sum(1 for r in rows if r["status"] == "Renovado")
                cancelled = sum(1 for r in rows if r["status"] == "Cancelado")
                pending   = sum(1 for r in rows if r["status"] == "Pendente")
                print(f"   Renovado: {renewed} | Cancelado: {cancelled} | Pendente: {pending}")
                n = load_status_rows(bq, rows, sem)
                print(f"   {n} rows stored")
            did_anything = True

    if not did_anything:
        print(f"\nNo active milestones or tracking windows today. Exiting.")


if __name__ == "__main__":
    main()
