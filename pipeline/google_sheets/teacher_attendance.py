"""Pull teacher attendance and lateness from Google Sheets."""

from datetime import date


def fetch(sheets_client) -> list[dict]:
    today = date.today().isoformat()
    raw = sheets_client.get_teacher_attendance()

    rows = []
    for t in raw:
        rows.append({
            "date": today,
            "branch": t.get("branch"),
            "teacher": t.get("teacher"),
            "classes_missed": t.get("classes_missed"),
            "late_arrivals": t.get("late_arrivals"),
            "trainings_attended": t.get("trainings_attended"),
        })
    return rows
