"""
upload_contacts.py
==================
Uploads contacts CSV to BigQuery as the `contacts` table.
Normalizes accented characters for reliable name matching.

How to run:
  export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service_account.json"
  export GCP_PROJECT_ID="cultura-hub"
  python3 upload_contacts.py contacts_setubal.csv

Add more branches by running again with a different CSV file.
"""

import sys
import unicodedata
import pandas as pd
from google.cloud import bigquery

PROJECT = "cultura-hub"
DATASET = "cultura_hub"
TABLE   = "contacts"

def normalize(s):
    """Remove accents for matching — CORRÊA → CORREA"""
    return unicodedata.normalize("NFD", str(s)).encode("ascii", "ignore").decode("ascii").upper().strip()

def main(csv_path):
    df = pd.read_csv(csv_path)
    
    # Add normalized name for matching with BigQuery students table
    df["student_name_normalized"] = df["student_name"].apply(normalize)
    
    print(f"Uploading {len(df)} contacts from {csv_path}...")
    print(df.head(3).to_string())

    client    = bigquery.Client(project=PROJECT)
    table_ref = f"{PROJECT}.{DATASET}.{TABLE}"

    # Create table if not exists
    schema = [
        bigquery.SchemaField("student_name",            "STRING"),
        bigquery.SchemaField("student_name_normalized",  "STRING"),
        bigquery.SchemaField("responsible_name",         "STRING"),
        bigquery.SchemaField("phone",                    "STRING"),
        bigquery.SchemaField("branch",                   "STRING"),
    ]

    table = bigquery.Table(table_ref, schema=schema)
    # table already created manually in BigQuery console

    # Delete existing rows for this branch before inserting
    branch = df["branch"].iloc[0]
    client.query(f"DELETE FROM `{table_ref}` WHERE branch = '{branch}'").result()
    print(f"Cleared existing {branch} contacts")

    # Upload
    job_config = bigquery.LoadJobConfig(
        schema=schema,
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
    )
    job = client.load_table_from_dataframe(df, table_ref, job_config=job_config)
    job.result()
    print(f"✅ Uploaded {len(df)} contacts for {branch}")

if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "contacts_setubal.csv"
    main(csv_path)
