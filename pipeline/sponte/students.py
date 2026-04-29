import os
from datetime import date


def fetch(sponte_client) -> list[dict]:
    """Return rows matching the `students` BigQuery schema."""
    today = date.today().isoformat()
    branch = os.environ.get("SPONTE_BRANCH_CURRENT", "")
    raw = sponte_client.get_students()

    rows = []
    for s in raw:
        rows.append({
            "date": today,
            "branch": branch,
            "student_id": str(s.get("id")),
            "name": s.get("name"),
            "status": s.get("status"),
            "discount_percent": s.get("discount_percent"),
            "monthly_value": s.get("monthly_value"),
            "class_id": str(s.get("class_id")) if s.get("class_id") else None,
            "teacher": s.get("teacher"),
        })
    return rows
