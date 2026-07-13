"""
pipeline/rd_station/tasks.py
Fetches late tasks from RD Station CRM.

A "late task" is a task whose due date has passed and hasn't been
marked as done. This is a signal of operational health — deals with
many overdue tasks are being neglected by the sales team.

Separate table from leads because tasks and deals have different shapes.
Mixing them in one table creates a sparse table where half the columns
are always NULL — a sign of bad data modeling. Join on deal_id when needed.

Why pipeline_name comes from deal_pipeline_map and not stage maps:
The /tasks API returns a minimal deal snapshot per task:
  { "id": "...", "name": "Lucas", "hold": null, "rating": 1 }
It does NOT include deal_stage. Without a stage_id, we can't look up
the pipeline from the stage maps. Instead, we use a deal_id->pipeline_name
map built from the leads rows already fetched in run_leads.py.
Zero extra API calls — we reuse data already in memory.

Why we fetch with done=False (2026-07-09):
RD Station's list endpoints cap out at 10,000 records per fetch -- this
account's task history (done + not done, going back to whenever the
account started) crossed that wall and get_all_tasks() started failing
with HTTP 400 on page 51. Since this page only ever needed the *late*
(overdue + undone) subset anyway, filtering to done=False server-side
both fixes the crash and matches what the page actually uses -- it's
not a workaround bolted on top of unrelated logic.
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


def fetch(
    rd_client,
    stage_pipeline_map: dict,
    stage_pname_map: dict,
    deal_pipeline_map: dict,
) -> list[dict]:
    """
    Fetch all late tasks and return rows ready for BigQuery.

    Parameters
    ----------
    rd_client
        The RD Station API client.

    stage_pipeline_map : dict
        stage_id -> pipeline_id. Passed in from run_leads.py.
        Used as a fallback if a task's deal somehow has stage info.

    stage_pname_map : dict
        stage_id -> pipeline_name. Same fallback purpose.

    deal_pipeline_map : dict
        deal_id -> pipeline_name. Built from leads rows in run_leads.py.
        This is the PRIMARY source for resolving pipeline_name in tasks,
        because the /tasks API doesn't include deal_stage in its response.

    Why receive four parameters instead of building everything internally?
    All maps are built once in run_leads.py and shared. This avoids
    redundant API calls and guarantees consistency across both tables.
    """
    today    = date.today().isoformat()
    today_dt = date.today()

    print(f"  [tasks] Fetching incomplete tasks...")
    # done=False is a server-side filter (see module docstring) -- it's
    # what keeps this fetch under RD Station's 10,000-record cap, not
    # just a local optimization. Do not remove this without re-checking
    # the total task count against that cap first.
    tasks = rd_client.get_all_tasks(done=False)

    rows       = []
    late_count = 0
    skip_count = 0

    for t in tasks:
        # Belt-and-suspenders: the API filter above should already
        # guarantee this, but a task could in principle flip to done in
        # the moment between the fetch starting and this loop running.
        # Cheap to check locally, costly to trust blindly.
        if t.get("done"):
            skip_count += 1
            continue

        task_date = _parse_date(t.get("date"))

        # Skip tasks with no due date or due date today/future.
        # A task is "late" only if its due date is strictly before today.
        if not task_date or task_date >= today:
            skip_count += 1
            continue

        days_late = (today_dt - date.fromisoformat(task_date)).days

        deal    = t.get("deal") or {}
        deal_id = t.get("deal_id", "")

        # Resolve pipeline_name via the deal map (primary path).
        # The /tasks API doesn't include deal_stage in the deal snapshot,
        # so stage_pipeline_map can't help us here. The deal_pipeline_map
        # — built from the leads we already fetched — is the correct source.
        pipeline_name = deal_pipeline_map.get(deal_id, "")
        pipeline_id   = ""

        # Fallback: if the task's deal object happens to include stage info
        # (which the current API doesn't, but might in future versions),
        # use the stage map. This makes the code forward-compatible.
        stage_id = (deal.get("deal_stage") or {}).get("id", "")
        if stage_id and not pipeline_name:
            pipeline_name = stage_pname_map.get(stage_id, "")
            pipeline_id   = stage_pipeline_map.get(stage_id, "")
        elif pipeline_name:
            # Resolve pipeline_id from the name via reverse lookup.
            # Less efficient than a direct map but avoids storing a second
            # deal_id->pipeline_id map in the orchestrator.
            pipeline_id = next(
                (pid for pid, pname in
                 zip(stage_pipeline_map.values(), stage_pname_map.values())
                 if pname == pipeline_name),
                ""
            )

        users          = t.get("users") or []
        responsible    = users[0].get("name", "") if users else ""
        responsible_id = users[0].get("id", "")   if users else ""

        rows.append({
            "date":           today,
            "deal_id":        deal_id,
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

    print(f"  [tasks] Fetched {len(tasks)} incomplete tasks from RD Station")
    print(f"  [tasks] {late_count} late tasks ({skip_count} skipped — not yet due)")
    return rows
