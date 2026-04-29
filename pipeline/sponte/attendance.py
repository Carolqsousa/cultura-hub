import os
"""Pull student attendance from Sponte API."""

from datetime import date


def fetch(sponte_client) -> list[dict]:
    today = date.today().isoformat()
    raw = sponte_client.get_attendance()

    rows = []
    for a in raw:
        rows.append({
            "date": today,
            "branch": os.environ.get("SPONTE_BRANCH_CURRENT", ""),
            "student_id": str(a.get("student_id")),
            "class_id": str(a.get("class_id")) if a.get("class_id") else None,
            "presence_rate": a.get("presence_rate"),
            "classes_missed": a.get("classes_missed"),
        })
    return rows
