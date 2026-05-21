"""
create_grades_table.py
======================
Cria a tabela grades no BigQuery.
Roda uma vez só — não precisa do gcloud/bq CLI instalado.

Como rodar:
  export GOOGLE_APPLICATION_CREDENTIALS="/caminho/para/seu/service_account.json"
  python create_grades_table.py
"""

import os
from google.cloud import bigquery

PROJECT = os.getenv("GCP_PROJECT_ID", "cultura-hub")
DATASET = "cultura_hub"
TABLE   = "grades"

client     = bigquery.Client(project=PROJECT)
table_ref  = f"{PROJECT}.{DATASET}.{TABLE}"

schema = [
    bigquery.SchemaField("date",            "DATE",    mode="NULLABLE"),
    bigquery.SchemaField("branch",          "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("student_id",      "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("class_id",        "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("class_name",      "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("phase_name",      "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("grade_format",    "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("pc_average",      "FLOAT64", mode="NULLABLE"),
    bigquery.SchemaField("midterm_average", "FLOAT64", mode="NULLABLE"),
    bigquery.SchemaField("final_average",   "FLOAT64", mode="NULLABLE"),
    bigquery.SchemaField("overall_average", "FLOAT64", mode="NULLABLE"),
    bigquery.SchemaField("approved",        "BOOL",    mode="NULLABLE"),
    bigquery.SchemaField("provas_entered",  "STRING",  mode="NULLABLE"),
    bigquery.SchemaField("run_date",        "DATE",    mode="NULLABLE"),
]

table = bigquery.Table(table_ref, schema=schema)
table = client.create_table(table, exists_ok=True)
print(f"✅ Tabela criada: {table.project}.{table.dataset_id}.{table.table_id}")
