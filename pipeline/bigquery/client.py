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
        try:
            delete_sql = f"""
                DELETE FROM `{PROJECT_ID}.{DATASET_ID}.{table_name}`
                WHERE date = '{today}' AND branch = '{branch_val}'
            """
            get_client().query(delete_sql).result()
            print(f"  [bigquery] Cleared today's {table_name} for {branch_val}")
        except Exception as e:
            print(f"  [bigquery] Warning: could not delete {table_name} for {branch_val}: {e}")
    else:
        # no branch — delete all of today (for leads etc)
        try:
            delete_sql = f"""
                DELETE FROM `{PROJECT_ID}.{DATASET_ID}.{table_name}`
                WHERE date = '{today}'
            """
            get_client().query(delete_sql).result()
        except Exception as e:
            print(f"  [bigquery] Warning: could not delete {table_name}: {e}")

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
