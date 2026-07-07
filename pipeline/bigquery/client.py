import json
import os
import datetime
from pathlib import Path
from google.cloud import bigquery

PROJECT_ID  = os.environ["GCP_PROJECT_ID"]
DATASET_ID  = os.environ.get("BQ_DATASET", "cultura_hub")
SCHEMAS_DIR = Path(__file__).parent / "schemas"

_client = None

def get_client():
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT_ID)
    return _client

def _load_schema(table_name):
    schema_path = SCHEMAS_DIR / f"{table_name}.json"
    fields = json.loads(schema_path.read_text())
    return [bigquery.SchemaField(f["name"], f["type"], mode=f["mode"]) for f in fields]

def ensure_table(table_name):
    client   = get_client()
    table_id = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
    schema   = _load_schema(table_name)
    table    = bigquery.Table(table_id, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="date")
    client.create_table(table, exists_ok=True)

def upsert_rows(table_name, rows, branch=None):
    """
    Delete today's rows for this branch then insert fresh ones.
    Uses load job (no streaming buffer issues).

    WHY THE DELETE MUST SUCCEED BEFORE THE INSERT RUNS:
    This whole function's safety (safe to rerun without duplicating data)
    depends on the delete actually clearing today's old rows first. If the
    delete fails and we insert anyway, today's new rows land ON TOP of the
    old ones -- silent duplication, no error, nothing visibly wrong. That's
    the same "silent partial failure" shape found and fixed elsewhere in
    this project today (a mid-pagination API failure silently truncating
    data). This function raises on a delete failure instead of warning and
    continuing, so a real problem here shows up as a loud, red CI failure
    instead of quietly duplicated rows nobody notices until the numbers
    look off downstream.
    """
    if not rows:
        print(f"  [bigquery] No rows to write for {table_name}, skipping")
        return

    client   = get_client()
    table_id = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
    today    = datetime.date.today().isoformat()

    # delete today's rows for this branch only
    branch_val = branch or os.environ.get("SPONTE_BRANCH_CURRENT", "")
    if branch_val:
        delete_sql = f"""
            DELETE FROM `{PROJECT_ID}.{DATASET_ID}.{table_name}`
            WHERE date = '{today}' AND branch = '{branch_val}'
        """
    else:
        # no branch — delete all of today (for leads, tasks, leads_natal, etc.)
        delete_sql = f"""
            DELETE FROM `{PROJECT_ID}.{DATASET_ID}.{table_name}`
            WHERE date = '{today}'
        """

    try:
        get_client().query(delete_sql).result()
        print(f"  [bigquery] Cleared today's {table_name}" + (f" for {branch_val}" if branch_val else ""))
    except Exception as e:
        # RAISE, not warn-and-continue: inserting on top of a failed delete
        # silently duplicates every row for today. A loud failure here is
        # strictly safer than a clean-looking run with corrupted data.
        raise RuntimeError(
            f"[bigquery] DELETE failed for {table_name} (branch={branch_val or 'none'}): {e}. "
            f"Aborting before insert -- proceeding would silently duplicate today's rows."
        ) from e

    # insert using load job with WRITE_APPEND
    job_config = bigquery.LoadJobConfig(
        schema             = _load_schema(table_name),
        write_disposition  = bigquery.WriteDisposition.WRITE_APPEND,
        create_disposition = bigquery.CreateDisposition.CREATE_IF_NEEDED,
        time_partitioning  = bigquery.TimePartitioning(field="date"),
    )

    job = client.load_table_from_json(rows, table_id, job_config=job_config)
    job.result()

    if job.errors:
        raise RuntimeError(f"BigQuery load errors for {table_name}: {job.errors}")

    print(f"  [bigquery] {table_name}: {len(rows)} rows written for {branch_val or 'all'}")
