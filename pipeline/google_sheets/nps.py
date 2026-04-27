"""Pull NPS scores from Google Sheets."""

from datetime import date


def fetch(sheets_client) -> list[dict]:
    today = date.today().isoformat()
    raw = sheets_client.get_nps()

    rows = []
    for n in raw:
        rows.append({
            "date": today,
            "branch": n.get("branch"),
            "teacher": n.get("teacher"),
            "score": n.get("score"),
            "responses": n.get("responses"),
        })
    return rows
