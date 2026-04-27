"""Pull enrollment goals from Google Sheets."""


def fetch(sheets_client) -> list[dict]:
    raw = sheets_client.get_goals()

    rows = []
    for g in raw:
        rows.append({
            "semester": g.get("semester"),
            "branch": g.get("branch"),
            "enrollment_goal": g.get("enrollment_goal"),
            "current_enrollments": g.get("current_enrollments"),
        })
    return rows
