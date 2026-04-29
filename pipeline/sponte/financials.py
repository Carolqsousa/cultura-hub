import os
"""Pull financial / delinquency data from Sponte API."""

from datetime import date


def fetch(sponte_client) -> list[dict]:
    today = date.today().isoformat()
    raw = sponte_client.get_financials()

    rows = []
    for f in raw:
        rows.append({
            "date": today,
            "branch": os.environ.get("SPONTE_BRANCH_CURRENT", ""),
            "student_id": str(f.get("student_id")),
            "amount_due": f.get("amount_due"),
            "amount_paid": f.get("amount_paid"),
            "status": f.get("status"),
            "months_behind": f.get("months_behind"),
        })
    return rows
