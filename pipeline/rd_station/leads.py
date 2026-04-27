"""Pull leads and pipeline data from RD Station API."""

from datetime import date


def fetch(rd_client) -> list[dict]:
    today = date.today().isoformat()
    raw = rd_client.get_leads()

    rows = []
    for lead in raw:
        rows.append({
            "date": today,
            "branch": lead.get("branch"),
            "new_leads": lead.get("new_leads"),
            "pipeline_stage": lead.get("pipeline_stage"),
            "source": lead.get("source"),
        })
    return rows
