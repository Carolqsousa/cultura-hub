"""
pipeline/sponte/financials.py

Fetches pending receivables for active students only.
Active = enrolled in an open class this semester.
"""

import os
import time
from datetime import date


def fetch(sponte_client) -> list[dict]:
    today    = date.today().isoformat()
    branch   = os.environ.get("SPONTE_BRANCH_CURRENT", "")
    semester = os.environ.get("SPONTE_SEMESTER", "2026.1")

    # get unique student IDs from open classes this semester
    print(f"  [financials] Collecting active student IDs for {branch}...")
    student_ids = sponte_client.get_active_student_ids(semester)
    print(f"  [financials] {len(student_ids)} active students found")

    rows = []
    for i, student_id in enumerate(student_ids):
        pending = sponte_client.get_receivables(student_id)

        for p in pending:
            rows.append({
                "date":          today,
                "branch":        branch,
                "student_id":    str(student_id),
                "receivable_id": str(p.get("receivables_id", "")),
                "parcel_number": p.get("parcel_number"),
                "description":   str(p.get("name") or p.get("description") or ""),
                "value":         _safe_float(p.get("value")),
                "maturity":      _parse_date(p.get("maturity")),
                "status":        int(p.get("status", 0)),
                "value_paid":    _safe_float(p.get("value_paid")),
                "payment_date":  _parse_date(p.get("payment_date")),
                "run_date":      today,
            })

        time.sleep(0.05)

        if i % 50 == 0 and i > 0:
            print(f"  [financials] {i}/{len(student_ids)} students, {len(rows)} pending parcels")

    print(f"  [financials] Done — {len(rows)} pending parcels for {branch}")
    return rows


def _safe_float(val):
    try:
        return float(str(val).replace(",", "."))
    except Exception:
        return 0.0


def _parse_date(raw):
    if not raw:
        return None
    raw = str(raw)[:10]
    try:
        from datetime import datetime
        if "-" in raw:
            return raw
        if "/" in raw:
            return datetime.strptime(raw, "%d/%m/%Y").date().isoformat()
    except Exception:
        pass
    return None
