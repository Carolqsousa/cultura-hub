"""Pull weekly to-do list from Google Sheets."""


def fetch(sheets_client) -> list[dict]:
    raw = sheets_client.get_todos()

    rows = []
    for t in raw:
        rows.append({
            "week": t.get("week"),
            "branch": t.get("branch"),
            "manager": t.get("manager"),
            "task": t.get("task"),
            "due_date": t.get("due_date"),
            "done": t.get("done", False),
        })
    return rows
