"""BigQuery client — loads schemas and upserts daily snapshots."""

import json
import os
from pathlib import Path

from google.cloud import bigquery

PROJECT_ID = os.environ["GCP_PROJECT_ID"]
DATASET_ID = os.environ.get("BQ_DATASET", "cultura_hub")

SCHEMAS_DIR = Path(__file__).parent / "schemas"

_client: bigquery.Client | None = None


def get_client() -> bigquery.Client:
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT_ID)
    return _client


def _load_schema(table_name: str) -> list[bigquery.SchemaField]:
    schema_path = SCHEMAS_DIR / f"{table_name}.json"
    fields = json.loads(schema_path.read_text())
    return [
        bigquery.SchemaField(f["name"], f["type"], mode=f["mode"])
        for f in fields
    ]


def ensure_table(table_name: str) -> None:
    """Create table if it doesn't exist."""
    client = get_client()
    table_id = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
    schema = _load_schema(table_name)
    table = bigquery.Table(table_id, schema=schema)
    table.time_partitioning = bigquery.TimePartitioning(field="date")
    client.create_table(table, exists_ok=True)


def upsert_rows(table_name: str, rows: list[dict]) -> None:
    """Replace today's partition with fresh rows."""
    if not rows:
        return
    client = get_client()
    table_id = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
    errors = client.insert_rows_json(table_id, rows)
    if errors:
        raise RuntimeError(f"BigQuery insert errors for {table_name}: {errors}")
