import os
"""Pull student grades from Sponte API."""

from datetime import date


def fetch(sponte_client) -> list[dict]:
    today = date.today().isoformat()
    raw = sponte_client.get_grades()

    rows = []
    for g in raw:
        rows.append({
            "date": today,
            "branch": os.environ.get("SPONTE_BRANCH_CURRENT", ""),
            "student_id": str(g.get("student_id")),
            "class_id": str(g.get("class_id")) if g.get("class_id") else None,
            "average": g.get("average"),
            "situation": g.get("situation"),
        })
    return rows
