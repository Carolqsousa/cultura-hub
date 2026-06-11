"""
pipeline/sponte/retention_snapshot.py
======================================
Captures retention metrics at semester milestone dates and stores them
permanently in BigQuery `retention_history` table.

Runs automatically on:
  2026.1: Feb 1, Mar 15, Jun 29
  2026.2: Aug 1, Sep 15, Dec 30
  (and repeats for future semesters)

If the students snapshot for the target date doesn't exist (e.g. Feb 1 has
no pipeline data), it uses the nearest available snapshot and marks rows
with is_estimated = True so analysts know the numbers are approximate.

Dimensions captured:
  - Global (per branch): active students, avg freq, total churn,
                         real churn, retention %
  - Per stage:           active students, real churn, retention %
  - Per teacher:         active students, class count, avg freq,
                         real churn, retention %
  - Per class:           active students, avg freq, real churn,
                         retention %, teacher

Usage:
  python3 pipeline/sponte/retention_snapshot.py

GitHub Actions: see .github/workflows/retention_snapshot.yml
"""

import os
import json
from datetime import datetime, date, timezone
from google.oauth2.service_account import Credentials
from google.cloud import bigquery

# ─── Config ───────────────────────────────────────────────────────────────────

GCP_PROJECT    = os.environ.get("GCP_PROJECT_ID", "cultura-hub")
BQ_DATASET     = "cultura_hub"
BQ_TABLE       = "retention_history"
GCP_CREDS_JSON = os.environ["GCP_CREDENTIALS_JSON"]

# Semester definitions — add future semesters here
SEMESTERS = [
    {
        "semester":   "2026.1",
        "start_date": "2026-02-01",
        "end_date":   "2026-06-29",
        "snapshots": [
            {"date": "2026-02-01", "type": "start"},
            {"date": "2026-03-15", "type": "mid"},
            {"date": "2026-06-29", "type": "end"},
        ],
    },
    {
        "semester":   "2026.2",
        "start_date": "2026-08-01",
        "end_date":   "2026-12-30",
        "snapshots": [
            {"date": "2026-08-01",  "type": "start"},
            {"date": "2026-09-15",  "type": "mid"},
            {"date": "2026-12-30",  "type": "end"},
        ],
    },
]

# Stage regex — same as quality route
STAGE_REGEX = r"r'(?i)(ADV|BGN|ELE|INT|MST|PTEE|TEE|TEA|UPP|VAN|JUN|CPSTA|PSTA|STA|NUR|YNG|TTM|IE_FRA|PRI|TOD)'"

STAGE_NORMALIZE = f"""
  CASE UPPER(REGEXP_EXTRACT(class_name, {STAGE_REGEX}))
    WHEN 'TTM'    THEN 'TEA'
    WHEN 'IE_FRA' THEN 'FRA'
    ELSE UPPER(REGEXP_EXTRACT(class_name, {STAGE_REGEX}))
  END
"""

# XLS branch normalization
XLS_BRANCH_NORMALIZE = """
  CASE branch
    WHEN 'BV'            THEN 'Boa Viagem'
    WHEN 'YG'            THEN 'Young'
    WHEN 'SET'           THEN 'Setubal'
    WHEN 'CI Lagoa Nova' THEN 'Natal'
    ELSE branch
  END
"""

# ─── BigQuery client ──────────────────────────────────────────────────────────

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


# ─── Schema ───────────────────────────────────────────────────────────────────

BQ_SCHEMA = [
    bigquery.SchemaField("captured_at",    "TIMESTAMP"),
    bigquery.SchemaField("semester",       "STRING"),
    bigquery.SchemaField("snapshot_date",  "DATE"),
    bigquery.SchemaField("snapshot_type",  "STRING"),   # start | mid | end
    bigquery.SchemaField("is_estimated",   "BOOLEAN"),  # True if nearest snapshot used
    bigquery.SchemaField("actual_snap_date", "DATE"),   # actual snapshot date used
    bigquery.SchemaField("dimension",      "STRING"),   # global | stage | teacher | class
    bigquery.SchemaField("branch",         "STRING"),
    bigquery.SchemaField("stage",          "STRING"),
    bigquery.SchemaField("teacher",        "STRING"),
    bigquery.SchemaField("class_name",     "STRING"),
    bigquery.SchemaField("student_count",  "INTEGER"),
    bigquery.SchemaField("class_count",    "INTEGER"),  # teachers only
    bigquery.SchemaField("avg_freq",       "FLOAT"),
    bigquery.SchemaField("total_churn",    "INTEGER"),  # global only: all cancellations
    bigquery.SchemaField("real_churn",     "INTEGER"),  # all dimensions
    bigquery.SchemaField("retention_pct",  "FLOAT"),
]


def ensure_table(bq):
    ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"
    try:
        bq.get_table(ref)
        print(f"  ✅ Table {BQ_TABLE} exists")
    except Exception:
        table = bigquery.Table(ref, schema=BQ_SCHEMA)
        bq.create_table(table)
        print(f"  ✅ Created table {BQ_TABLE}")


# ─── Snapshot date resolution ─────────────────────────────────────────────────

def resolve_snapshot_date(bq, target_date: str, table: str) -> tuple[str, bool]:
    """
    Find the closest available snapshot on or before target_date.
    Returns (actual_date, is_estimated).
    is_estimated=True if actual_date != target_date.
    """
    sql = f"""
        SELECT MAX(date) AS d
        FROM `{GCP_PROJECT}.{BQ_DATASET}.{table}`
        WHERE date <= '{target_date}'
    """
    rows = bq_query(bq, sql)
    actual = rows[0]["d"] if rows and rows[0]["d"] else None
    if not actual:
        return None, True
    actual_str = actual.strftime("%Y-%m-%d") if hasattr(actual, "strftime") else str(actual)
    return actual_str, (actual_str != target_date)


# ─── Query builders ───────────────────────────────────────────────────────────

def capture_global(bq, semester, snapshot_date, start_date, snap_date, is_estimated):
    """Global metrics per branch."""
    sql = f"""
        WITH
          active AS (
            SELECT branch, COUNT(DISTINCT student_id) AS student_count
            FROM `{GCP_PROJECT}.{BQ_DATASET}.students`
            WHERE date = '{snap_date}'
            GROUP BY branch
          ),
          freq AS (
            SELECT branch, ROUND(AVG(pct_presence), 1) AS avg_freq
            FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
            WHERE date = (
              SELECT MAX(date) FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
              WHERE date <= '{snapshot_date}'
            )
            GROUP BY branch
          ),
          churn AS (
            SELECT
              {XLS_BRANCH_NORMALIZE} AS branch,
              COUNT(*) AS total_churn,
              COUNTIF(is_real_churn) AS real_churn
            FROM `{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls`
            WHERE semester = '{semester}'
              AND event_date BETWEEN '{start_date}' AND '{snapshot_date}'
            GROUP BY branch
          )
        SELECT
          a.branch,
          a.student_count,
          f.avg_freq,
          COALESCE(c.total_churn, 0) AS total_churn,
          COALESCE(c.real_churn, 0)  AS real_churn,
          ROUND(SAFE_DIVIDE(
            a.student_count,
            a.student_count + COALESCE(c.real_churn, 0)
          ) * 100, 1) AS retention_pct
        FROM active a
        LEFT JOIN freq  f USING (branch)
        LEFT JOIN churn c USING (branch)
        ORDER BY a.branch
    """
    rows = bq_query(bq, sql)
    return [{
        "dimension":    "global",
        "branch":       r["branch"],
        "stage":        "",
        "teacher":      "",
        "class_name":   "",
        "student_count": r["student_count"],
        "class_count":  None,
        "avg_freq":     float(r["avg_freq"]) if r["avg_freq"] else None,
        "total_churn":  r["total_churn"],
        "real_churn":   r["real_churn"],
        "retention_pct": float(r["retention_pct"]) if r["retention_pct"] else None,
    } for r in rows]


def capture_by_stage(bq, semester, snapshot_date, start_date, snap_date):
    """Retention per branch + stage."""
    sql = f"""
        WITH
          latest_att AS (
            SELECT student_id, branch,
              CASE UPPER(REGEXP_EXTRACT(MAX(class_name), {STAGE_REGEX}))
                WHEN 'TTM'    THEN 'TEA'
                WHEN 'IE_FRA' THEN 'FRA'
                ELSE UPPER(REGEXP_EXTRACT(MAX(class_name), {STAGE_REGEX}))
              END AS stage
            FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
            WHERE date = (
              SELECT MAX(date) FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
              WHERE date <= '{snapshot_date}'
            )
            GROUP BY student_id, branch
          ),
          active AS (
            SELECT s.branch, COALESCE(a.stage, '?') AS stage,
              COUNT(DISTINCT s.student_id) AS student_count
            FROM `{GCP_PROJECT}.{BQ_DATASET}.students` s
            LEFT JOIN latest_att a USING (student_id, branch)
            WHERE s.date = '{snap_date}'
            GROUP BY s.branch, stage
          ),
          churn AS (
            SELECT
              {XLS_BRANCH_NORMALIZE} AS branch,
              CASE UPPER(REGEXP_EXTRACT(class_name, {STAGE_REGEX}))
                WHEN 'TTM'    THEN 'TEA'
                WHEN 'IE_FRA' THEN 'FRA'
                ELSE UPPER(REGEXP_EXTRACT(class_name, {STAGE_REGEX}))
              END AS stage,
              COUNTIF(is_real_churn) AS real_churn
            FROM `{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls`
            WHERE semester = '{semester}'
              AND event_date BETWEEN '{start_date}' AND '{snapshot_date}'
            GROUP BY branch, stage
          )
        SELECT
          a.branch, a.stage, a.student_count,
          COALESCE(c.real_churn, 0) AS real_churn,
          ROUND(SAFE_DIVIDE(
            a.student_count,
            a.student_count + COALESCE(c.real_churn, 0)
          ) * 100, 1) AS retention_pct
        FROM active a
        LEFT JOIN churn c USING (branch, stage)
        WHERE a.stage != '?'
        ORDER BY a.branch, a.stage
    """
    rows = bq_query(bq, sql)
    return [{
        "dimension":     "stage",
        "branch":        r["branch"],
        "stage":         r["stage"],
        "teacher":       "",
        "class_name":    "",
        "student_count": r["student_count"],
        "class_count":   None,
        "avg_freq":      None,
        "total_churn":   None,
        "real_churn":    r["real_churn"],
        "retention_pct": float(r["retention_pct"]) if r["retention_pct"] else None,
    } for r in rows]


def capture_by_teacher(bq, semester, snapshot_date, start_date, snap_date):
    """Retention per teacher."""
    sql = f"""
        WITH
          teacher_classes AS (
            SELECT professor AS teacher, class_id, branch
            FROM `{GCP_PROJECT}.{BQ_DATASET}.diary_checks`
            WHERE date <= '{snapshot_date}'
              AND professor IS NOT NULL AND professor != ''
            GROUP BY professor, class_id, branch
          ),
          latest_grades AS (
            SELECT class_id, branch, MAX(date) AS grade_date
            FROM `{GCP_PROJECT}.{BQ_DATASET}.grades`
            WHERE date <= '{snapshot_date}'
            GROUP BY class_id, branch
          ),
          latest_att AS (
            SELECT class_id, branch, AVG(pct_presence) AS pct_presence
            FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
            WHERE date = (
              SELECT MAX(date) FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
              WHERE date <= '{snapshot_date}'
            )
            GROUP BY class_id, branch
          ),
          teacher_stats AS (
            SELECT
              tc.teacher,
              COUNT(DISTINCT tc.class_id)    AS class_count,
              COUNT(DISTINCT gr.student_id)  AS student_count,
              ROUND(AVG(la.pct_presence), 1) AS avg_freq
            FROM teacher_classes tc
            LEFT JOIN latest_att la USING (class_id, branch)
            LEFT JOIN `{GCP_PROJECT}.{BQ_DATASET}.grades` gr
              ON gr.class_id = tc.class_id AND gr.branch = tc.branch
            LEFT JOIN latest_grades lg
              ON lg.class_id = tc.class_id AND lg.branch = tc.branch
              AND gr.date = lg.grade_date
            GROUP BY tc.teacher
          ),
          churn AS (
            SELECT teacher,
              COUNTIF(is_real_churn) AS real_churn
            FROM `{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls`
            WHERE semester = '{semester}'
              AND event_date BETWEEN '{start_date}' AND '{snapshot_date}'
            GROUP BY teacher
          )
        SELECT
          ts.teacher,
          ts.class_count,
          ts.student_count,
          ts.avg_freq,
          COALESCE(c.real_churn, 0) AS real_churn,
          ROUND(SAFE_DIVIDE(
            ts.student_count,
            ts.student_count + COALESCE(c.real_churn, 0)
          ) * 100, 1) AS retention_pct
        FROM teacher_stats ts
        LEFT JOIN churn c USING (teacher)
        ORDER BY ts.teacher
    """
    rows = bq_query(bq, sql)
    return [{
        "dimension":     "teacher",
        "branch":        "",
        "stage":         "",
        "teacher":       r["teacher"],
        "class_name":    "",
        "student_count": r["student_count"],
        "class_count":   r["class_count"],
        "avg_freq":      float(r["avg_freq"]) if r["avg_freq"] else None,
        "total_churn":   None,
        "real_churn":    r["real_churn"],
        "retention_pct": float(r["retention_pct"]) if r["retention_pct"] else None,
    } for r in rows]


def capture_by_class(bq, semester, snapshot_date, start_date, snap_date):
    """Retention per class."""
    sql = f"""
        WITH
          latest_grades AS (
            SELECT class_id, class_name, branch,
              {STAGE_NORMALIZE} AS stage,
              MAX(date) AS grade_date
            FROM `{GCP_PROJECT}.{BQ_DATASET}.grades`
            WHERE date <= '{snapshot_date}'
            GROUP BY class_id, class_name, branch, stage
          ),
          class_students AS (
            SELECT gr.class_id, gr.branch,
              COUNT(DISTINCT gr.student_id) AS student_count
            FROM `{GCP_PROJECT}.{BQ_DATASET}.grades` gr
            JOIN latest_grades lg
              ON gr.class_id = lg.class_id AND gr.branch = lg.branch
              AND gr.date = lg.grade_date
            GROUP BY gr.class_id, gr.branch
          ),
          class_freq AS (
            SELECT class_id, branch,
              ROUND(AVG(pct_presence), 1) AS avg_freq
            FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
            WHERE date = (
              SELECT MAX(date) FROM `{GCP_PROJECT}.{BQ_DATASET}.attendance`
              WHERE date <= '{snapshot_date}'
            )
            GROUP BY class_id, branch
          ),
          class_teachers AS (
            SELECT class_id, branch, MAX(professor) AS teacher
            FROM `{GCP_PROJECT}.{BQ_DATASET}.diary_checks`
            WHERE date <= '{snapshot_date}'
            GROUP BY class_id, branch
          ),
          class_cancels AS (
            SELECT
              TRIM(SPLIT(class_name, ' - ')[OFFSET(0)]) AS class_code,
              {XLS_BRANCH_NORMALIZE} AS branch,
              COUNTIF(is_real_churn) AS real_churn
            FROM `{GCP_PROJECT}.{BQ_DATASET}.cancellations_xls`
            WHERE semester = '{semester}'
              AND event_date BETWEEN '{start_date}' AND '{snapshot_date}'
            GROUP BY class_code, branch
          )
        SELECT
          lg.class_name, lg.stage, lg.branch,
          COALESCE(ct.teacher, '')      AS teacher,
          COALESCE(cs.student_count, 0) AS student_count,
          cf.avg_freq,
          COALESCE(cc.real_churn, 0)    AS real_churn,
          ROUND(SAFE_DIVIDE(
            COALESCE(cs.student_count, 0),
            COALESCE(cs.student_count, 0) + COALESCE(cc.real_churn, 0)
          ) * 100, 1) AS retention_pct
        FROM latest_grades lg
        LEFT JOIN class_students cs ON cs.class_id = lg.class_id AND cs.branch = lg.branch
        LEFT JOIN class_freq      cf ON cf.class_id = lg.class_id AND cf.branch = lg.branch
        LEFT JOIN class_teachers  ct ON ct.class_id = lg.class_id AND ct.branch = lg.branch
        LEFT JOIN class_cancels   cc
          ON cc.class_code = TRIM(SPLIT(lg.class_name, ' - ')[OFFSET(0)])
          AND cc.branch = lg.branch
        ORDER BY lg.class_name
    """
    rows = bq_query(bq, sql)
    return [{
        "dimension":     "class",
        "branch":        r["branch"],
        "stage":         r["stage"] or "",
        "teacher":       r["teacher"],
        "class_name":    r["class_name"],
        "student_count": r["student_count"],
        "class_count":   None,
        "avg_freq":      float(r["avg_freq"]) if r["avg_freq"] else None,
        "total_churn":   None,
        "real_churn":    r["real_churn"],
        "retention_pct": float(r["retention_pct"]) if r["retention_pct"] else None,
    } for r in rows]


# ─── Loader ───────────────────────────────────────────────────────────────────

def load_rows(bq, rows, semester, snapshot_date, snapshot_type, is_estimated, actual_snap_date):
    if not rows:
        return 0

    now = datetime.now(timezone.utc).isoformat()
    for r in rows:
        r.update({
            "captured_at":      now,
            "semester":         semester,
            "snapshot_date":    snapshot_date,
            "snapshot_type":    snapshot_type,
            "is_estimated":     is_estimated,
            "actual_snap_date": actual_snap_date,
        })

    table_ref = f"{GCP_PROJECT}.{BQ_DATASET}.{BQ_TABLE}"

    # Delete existing rows for this semester + snapshot_date to allow reruns
    bq.query(f"""
        DELETE FROM `{table_ref}`
        WHERE semester = '{semester}' AND snapshot_date = '{snapshot_date}'
    """).result()

    job = bq.load_table_from_json(
        rows, table_ref,
        job_config=bigquery.LoadJobConfig(
            schema=BQ_SCHEMA,
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        )
    )
    job.result()
    if job.errors:
        raise RuntimeError(f"Load errors: {job.errors}")
    return len(rows)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Allow date override for backfilling or testing
    # e.g. OVERRIDE_DATE=2026-03-15 python retention_snapshot.py
    today = os.environ.get("OVERRIDE_DATE", "").strip() or date.today().isoformat()
    print("=" * 60)
    print(f"  Retention Snapshot Pipeline")
    print(f"  Today: {today}")
    if os.environ.get("OVERRIDE_DATE"):
        print(f"  ⚠️  Using OVERRIDE_DATE — not the real today")
    print("=" * 60)

    bq = get_bq()
    ensure_table(bq)

    # Find which snapshots are due today
    due = []
    for sem in SEMESTERS:
        for snap in sem["snapshots"]:
            if snap["date"] == today:
                due.append({
                    "semester":      sem["semester"],
                    "start_date":    sem["start_date"],
                    "snapshot_date": snap["date"],
                    "snapshot_type": snap["type"],
                })

    if not due:
        print(f"\n📅 No snapshots scheduled for today ({today}). Exiting.")
        return

    print(f"\n📸 {len(due)} snapshot(s) due today:")
    for d in due:
        print(f"   {d['semester']} — {d['snapshot_type']} ({d['snapshot_date']})")

    for snap in due:
        semester      = snap["semester"]
        snapshot_date = snap["snapshot_date"]
        snapshot_type = snap["snapshot_type"]
        start_date    = snap["start_date"]

        print(f"\n{'─'*60}")
        print(f"📸 {semester} — {snapshot_type} snapshot ({snapshot_date})")

        # Resolve nearest student snapshot
        snap_date, is_estimated = resolve_snapshot_date(bq, snapshot_date, "students")
        if not snap_date:
            print(f"  ⚠️  No student snapshot available on or before {snapshot_date} — skipping")
            continue

        if is_estimated:
            print(f"  ⚠️  No snapshot for {snapshot_date} — using nearest: {snap_date} (is_estimated=True)")
        else:
            print(f"  ✅ Using snapshot date: {snap_date}")

        total = 0

        print("  → Global...")
        rows = capture_global(bq, semester, snapshot_date, start_date, snap_date, is_estimated)
        total += load_rows(bq, rows, semester, snapshot_date, snapshot_type, is_estimated, snap_date)

        print("  → By stage...")
        rows = capture_by_stage(bq, semester, snapshot_date, start_date, snap_date)
        total += load_rows(bq, rows, semester, snapshot_date, snapshot_type, is_estimated, snap_date)

        print("  → By teacher...")
        rows = capture_by_teacher(bq, semester, snapshot_date, start_date, snap_date)
        total += load_rows(bq, rows, semester, snapshot_date, snapshot_type, is_estimated, snap_date)

        print("  → By class...")
        rows = capture_by_class(bq, semester, snapshot_date, start_date, snap_date)
        total += load_rows(bq, rows, semester, snapshot_date, snapshot_type, is_estimated, snap_date)

        print(f"  ✅ {total} rows stored for {semester} {snapshot_type}")

    print(f"\n✅ Done.")


if __name__ == "__main__":
    main()
