"""
pipeline/rd_station/leads.py

Fetches deals and tasks from RD Station CRM.
Writes two types of rows:
  - One row per deal (funnel stage, source, responsible, status)
  - One row per late task (done=False and date < today)
"""

import os
from datetime import date, datetime


def fetch(rd_client) -> list[dict]:
    today     = date.today().isoformat()
    today_dt  = date.today()

    print(f"  [leads] Fetching all deals...")
    deals  = rd_client.get_all_deals()
    stages = rd_client.get_deal_stages()
    print(f"  [leads] {len(deals)} deals, {len(stages)} stages")

    stage_map = {s["id"]: s["name"] for s in stages}

    rows = []
    for d in deals:
        stage_id   = (d.get("deal_stage") or {}).get("id", "")
        stage_name = stage_map.get(stage_id, "")
        user       = d.get("user") or {}

        # determine status
        if d.get("win") is True:
            status = "won"
        elif d.get("win") is False:
            status = "lost"
        elif d.get("hold"):
            status = "paused"
        else:
            status = "open"

        rows.append({
            "date":           today,
            "record_type":    "deal",
            "deal_id":        d.get("id", ""),
            "name":           d.get("name", ""),
            "stage":          stage_name,
            "status":         status,
            "responsible":    user.get("name", ""),
            "responsible_id": user.get("id", ""),
            "created_at":     _parse_date(d.get("created_at")),
            "closed_at":      _parse_date(d.get("closed_at")),
            "rating":         d.get("rating"),
            "interactions":   d.get("interactions", 0),
            "task_subject":   None,
            "task_done":      None,
            "task_due_date":  None,
            "days_late":      None,
            "run_date":       today,
        })

    print(f"  [leads] Fetching all tasks...")
    tasks = rd_client.get_all_tasks()
    print(f"  [leads] {len(tasks)} tasks total")

    late_count = 0
    for t in tasks:
        if t.get("done"):
            continue
        task_date = _parse_date(t.get("date"))
        if not task_date or task_date >= today:
            continue  # not late yet

        # late task
        days_late = (today_dt - date.fromisoformat(task_date)).days
        users     = t.get("users") or []
        user_name = users[0].get("name", "") if users else ""
        user_id   = users[0].get("id", "")   if users else ""
        deal      = t.get("deal") or {}

        rows.append({
            "date":           today,
            "record_type":    "late_task",
            "deal_id":        t.get("deal_id", ""),
            "name":           deal.get("name", ""),
            "stage":          None,
            "status":         "late",
            "responsible":    user_name,
            "responsible_id": user_id,
            "created_at":     _parse_date(t.get("created_at")),
            "closed_at":      None,
            "rating":         None,
            "interactions":   None,
            "task_subject":   t.get("subject", ""),
            "task_done":      t.get("done", False),
            "task_due_date":  task_date,
            "days_late":      days_late,
            "run_date":       today,
        })
        late_count += 1

    print(f"  [leads] {late_count} late tasks")
    print(f"  [leads] Done — {len(rows)} total rows")
    return rows


def _parse_date(raw):
    if not raw:
        return None
    try:
        return raw[:10]
    except Exception:
        return None
