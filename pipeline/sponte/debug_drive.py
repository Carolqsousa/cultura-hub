"""
debug_drive.py
"""
import os
import json
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

DRIVE_FOLDER_ID = os.environ["DRIVE_CANCELLATIONS_FOLDER_ID"]
GCP_CREDS_JSON  = os.environ["GCP_CREDENTIALS_JSON"]

scopes = ["https://www.googleapis.com/auth/drive"]
creds  = Credentials.from_service_account_info(json.loads(GCP_CREDS_JSON), scopes=scopes)
drive  = build("drive", "v3", credentials=creds)

print(f"Folder ID: {DRIVE_FOLDER_ID}")

print("\n=== TEST 1: Get folder metadata ===")
try:
    folder = drive.files().get(fileId=DRIVE_FOLDER_ID, fields="id,name,mimeType").execute()
    print(f"  ✅ Folder found: {folder}")
except Exception as e:
    print(f"  ❌ Cannot access folder: {e}")

print("\n=== TEST 2: List ALL files in folder (no filter) ===")
try:
    resp = drive.files().list(
        q=f"'{DRIVE_FOLDER_ID}' in parents and trashed = false",
        fields="files(id, name, mimeType, size)",
    ).execute()
    files = resp.get("files", [])
    print(f"  Files found: {len(files)}")
    for f in files:
        print(f"    {f}")
except Exception as e:
    print(f"  ❌ Error: {e}")

print("\n=== TEST 3: List with .xls name filter ===")
try:
    resp = drive.files().list(
        q=f"'{DRIVE_FOLDER_ID}' in parents and trashed = false and (name contains '.xls')",
        fields="files(id, name, mimeType)",
    ).execute()
    files = resp.get("files", [])
    print(f"  XLS files found: {len(files)}")
    for f in files:
        print(f"    {f}")
except Exception as e:
    print(f"  ❌ Error: {e}")

print("\n=== TEST 4: Files visible to service account ===")
try:
    resp = drive.files().list(
        q="trashed = false",
        fields="files(id, name, mimeType, parents)",
        pageSize=10,
    ).execute()
    files = resp.get("files", [])
    print(f"  Total visible files: {len(files)}")
    for f in files:
        print(f"    {f}")
except Exception as e:
    print(f"  ❌ Error: {e}")
