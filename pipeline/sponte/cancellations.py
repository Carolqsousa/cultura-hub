"""
pipeline/sponte/cancellations.py
=================================
Detects cancellations by comparing the two most recent student snapshots
in BigQuery. No Sponte API calls needed — works purely from existing data.

Logic:
  student in snapshot[prev] but NOT in snapshot[curr] → cancelled

What's stored per cancellation:
  - cancellation_date (today's run date)
  - branch
  - student_id, student_name
  - class_id, class_name
  - teacher
  - stage (extracted from class_name)
  - last_seen_date (the date they were last in the students table)
  - run_date
"""

import re
from datetime import date
from google.cloud import bigquery

DATASET = "cultura_hub"

# Stage extraction patterns from class names
STAGE_PATTERNS = [
    (r'\bADV\b',  "ADV"),
    (r'\bBGN\b',  "BGN"),
    (r'\bELE\b',  "ELE"),
    (r'\bINT\b',  "INT"),
    (r'\bMST\b',  "MST"),
    (r'\bPRI\b',  "PRI"),
    (r'\bPST\b',  "PST"),
    (r'\bPTE\b',  "PTE"),
    (r'\bSTA\b',  "STA"),
    (r'\bTEA\b',  "TEA"),
    (r'\bTEE\b',  "TEE"),
    (r'\bUPP\b',  "UPP"),
    (r'\bYNG\b',  "YNG"),
    (r'\bYOUNG\b',"YNG"),
    (r'\bNUR\b',  "NUR"),
    (r'\bJUN\b',  "JUN"),
    (r'\bTEEN\b', "TEEN"),
]

def extract_stage(class_name: str) -> str:
    if not class_name:
        return "?"
    upper = class_name.upper()
    for pattern, stage in STAGE_PATTERNS:
        if re.search(pattern, upper):
            return stage
    return "?"


class CancellationDetector:
    def __init__(self, project: str):
        self.client  = bigquery.Client(project=project)
        self.project = project

    def _q(self, sql: str):
        return list(self.client.query(sql).result())

    def detect(self) -> list[dict]:
        """
        Compares the two most recent student snapshots and returns
        a list of cancellation dicts ready for BigQuery insertion.
        """
        # Get the two most recent snapshot dates
        dates = self._q(f"""
            SELECT DISTINCT date
            FROM `{self.project}.{DATASET}.students`
            ORDER BY date DESC
            LIMIT 2
        """)

        if len(dates) < 2:
            print("  [cancellations] Not enough snapshots to compare (need at least 2)")
            return []

        curr_date = dates[0]["date"]
        prev_date = dates[1]["date"]
        print(f"  [cancellations] Comparing {prev_date} → {curr_date}")

        # Get students from each snapshot
        curr_rows = self._q(f"""
            SELECT student_id, branch, class_id
            FROM `{self.project}.{DATASET}.students`
            WHERE date = '{curr_date}'
        """)

        prev_rows = self._q(f"""
            SELECT student_id, name, branch, class_id, teacher
            FROM `{self.project}.{DATASET}.students`
            WHERE date = '{prev_date}'
        """)

        # Build sets for comparison
        curr_set = {(str(r["student_id"]), str(r["class_id"]), r["branch"]) for r in curr_rows}
        prev_map = {
            (str(r["student_id"]), str(r["class_id"]), r["branch"]): r
            for r in prev_rows
        }

        # Cancelled = in prev but not in curr
        cancelled_keys = set(prev_map.keys()) - curr_set
        if not cancelled_keys:
            print("  [cancellations] No cancellations detected")
            return []

        print(f"  [cancellations] {len(cancelled_keys)} cancellations detected")

        # Get class names from diary_checks for enrichment
        class_names = {}
        diary_rows = self._q(f"""
            SELECT DISTINCT class_id, class_name
            FROM `{self.project}.{DATASET}.diary_checks`
            WHERE date = (SELECT MAX(date) FROM `{self.project}.{DATASET}.diary_checks`)
        """)
        for r in diary_rows:
            class_names[str(r["class_id"])] = r["class_name"] or ""

        # Also try attendance table for class names
        att_rows = self._q(f"""
            SELECT DISTINCT class_id, class_name
            FROM `{self.project}.{DATASET}.attendance`
            WHERE date = (SELECT MAX(date) FROM `{self.project}.{DATASET}.attendance`)
        """)
        for r in att_rows:
            if str(r["class_id"]) not in class_names:
                class_names[str(r["class_id"])] = r["class_name"] or ""

        today = date.today().isoformat()
        rows  = []

        for key in cancelled_keys:
            student_id, class_id, branch = key
            prev = prev_map[key]
            class_name = class_names.get(class_id, "")
            stage      = extract_stage(class_name)

            rows.append({
                "cancellation_date": today,
                "branch":            branch,
                "student_id":        student_id,
                "student_name":      prev.get("name") or "",
                "class_id":          class_id,
                "class_name":        class_name,
                "teacher":           prev.get("teacher") or "",
                "stage":             stage,
                "last_seen_date":    str(prev_date),
                "run_date":          today,
            })

        return rows
