"""
pipeline/rd_station/tasks.py
Fetches late tasks from RD Station CRM.

A "late task" is a task whose due date has passed and hasn't been
marked as done. This is a signal of operational health — deals with
many overdue tasks are being neglected by the sales team.

This is deliberately a SEPARATE table from leads because:
  - Tasks and deals have different shapes (different columns)
  - Mixing them creates a sparse table where half the columns are
    always NULL — a sign of bad data modeling
  - Separate tables make queries simpler and schemas easier to understand
  - You join them when needed via deal_id

One row per late task per run. The BigQuery writer deletes today's
rows before inserting, so running multiple times per day is safe.
"""

from datetime import date


def _parse_date(raw):
    """
    Extract just the date portion from a datetime string.
    RD Station returns ISO datetimes like '2026-07-02T18:13:34.275-03:00'.
    We keep only '2026-07-02'.
    """
    if not raw:
        return None
    return str(raw)[:10]


def fetch(rd_client, stage_pipeline_map: dict, stage_pname_map: dict) -> list[dict]:
    """
    Fetch all late tasks and return rows ready for BigQuery.

    Parameters
    ----------
    rd_client
        The RD Station API client — same instance used by leads.py.
        Passed in so we don't create a second client or make redundant
        API calls.

    stage_pipeline_map : dict
        stage_id -> pipeline_id, built once in run_leads.py and shared
        between leads.py and tasks.py. Avoids calling /deal_pipelines twice.

    stage_pname_map : dict
        stage_id -> pipeline_name, same sharing pattern.

    Why share the maps instead of fetching pipelines again?
    The pipeline map doesn't change between the deals fetch and the tasks
    fetch — they both run in the same pipeline execution. Fetching it twice
    would mean an extra API call, extra latency, and a small risk that the
    API returns slightly different data between the two calls (unlikely but
    possible if someone updates a funnel mid-run).
    """
    today    = date.today().isoformat()
    today_dt = date.today()

    print(f"  [tasks] Fetching all tasks...")
    tasks = rd_client.get_all_tasks()

    rows      = []
    late_count = 0
    skip_count = 0

    for t in tasks:
        # Skip completed tasks — we only care about overdue incomplete ones
        if t.get("done"):
            skip_count += 1
            continue

        task_date = _parse_date(t.get("date"))

        # Skip tasks with no due date or due date in the future/today
        # A task is only "late" if its due date is strictly before today
        if not task_date or task_date >= today:
            skip_count += 1
            continue

        days_late = (today_dt - date.fromisoformat(task_date)).days

        # The task object contains a nested deal snapshot (name + stage only,
        # not full deal data). We use it to resolve the pipeline.
        deal          = t.get("deal") or {}
        stage_id      = (deal.get("deal_stage") or {}).get("id", "")
        pipeline_id   = stage_pipeline_map.get(stage_id, "")
        pipeline_name = stage_pname_map.get(stage_id, "")

        # Tasks can have multiple assigned users — we take the first one.
        # In practice RD Station tasks are assigned to one person at a time.
        users         = t.get("users") or []
        responsible   = users[0].get("name", "") if users else ""
        responsible_id = users[0].get("id", "")  if users else ""

        rows.append({
            "date":           today,
            "deal_id":        t.get("deal_id", ""),
            "deal_name":      deal.get("name", ""),
            "pipeline_id":    pipeline_id,
            "pipeline_name":  pipeline_name,
            "responsible":    responsible,
            "responsible_id": responsible_id,
            "task_subject":   t.get("subject", ""),
            "task_due_date":  task_date,
            "days_late":      days_late,
            "run_date":       today,
        })
        late_count += 1

    print(f"  [tasks] {late_count} late tasks ({skip_count} skipped — done or not yet due)")
    return rows
