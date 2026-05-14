import json
import os
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

def upsert_rows(table_name, rows):
    """Replace today's partition using load job — no streaming buffer issues."""
    if not rows:
        print(f"  [bigquery] No rows to write for {table_name}, skipping")
        return

    import datetime
    client    = get_client()
    table_id  = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
    today     = datetime.date.today().strftime("%Y%m%d")
    partition = f"{table_id}${today}"

    job_config = bigquery.LoadJobConfig(
        schema              = _load_schema(table_name),
        write_disposition   = bigquery.WriteDisposition.WRITE_TRUNCATE,
        create_disposition  = bigquery.CreateDisposition.CREATE_IF_NEEDED,
        time_partitioning   = bigquery.TimePartitioning(field="date"),
    )

    job = client.load_table_from_json(rows, partition, job_config=job_config)
    job.result()  # wait for completion

    if job.errors:
        raise RuntimeError(f"BigQuery load errors for {table_name}: {job.errors}")

    print(f"  [bigquery] {table_name}: {len(rows)} rows written to partition {today}")
