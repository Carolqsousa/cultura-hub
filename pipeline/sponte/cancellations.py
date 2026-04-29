import os
"""Pull cancellations from Sponte API."""

from datetime import date


def fetch(sponte_client) -> list[dict]:
    today = date.today().isoformat()
    raw = sponte_client.get_cancellations()

    rows = []
    for c in raw:
        rows.append({
            "date": today,
            "branch": os.environ.get("SPONTE_BRANCH_CURRENT", ""),
            "student_id": str(c.get("student_id")),
            "reason": c.get("reason"),
            "cancellation_date": c.get("cancellation_date"),
        })
    return rows
